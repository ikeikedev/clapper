import type { TrackAudioState, MasterAudioState, CompState } from './types';

export const DEFAULT_EQ = { low: 0, lowMid: 0, mid: 0, highMid: 0, high: 0 };
export const DEFAULT_COMP: CompState = {
  threshold: -24,
  ratio: 2,
  attack: 0.003,
  release: 0.25,
  knee: 10
};
export const DEFAULT_TRACK_AUDIO_STATE: TrackAudioState = {
  volume: 1.0,
  pan: 0,
  isMono: false,
  isMuted: false,
  isSoloed: false,
  eq: { ...DEFAULT_EQ },
  comp: { ...DEFAULT_COMP }
};
export const DEFAULT_MASTER_STATE: MasterAudioState = {
  volume: 1.0,
  pan: 0,
  isMono: false,
  eq: { ...DEFAULT_EQ },
  comp: { ...DEFAULT_COMP, threshold: -6, ratio: 1.5 }
};

type TrackNodes = {
  gain: GainNode;
  panner: StereoPannerNode;
  eqLow: BiquadFilterNode;
  eqLowMid: BiquadFilterNode;
  eqMid: BiquadFilterNode;
  eqHighMid: BiquadFilterNode;
  eqHigh: BiquadFilterNode;
  comp: DynamicsCompressorNode;
  analyserL: AnalyserNode;
  analyserR: AnalyserNode;
};

type MasterNodes = {
  gain: GainNode;
  panner: StereoPannerNode;
  eqLow: BiquadFilterNode;
  eqLowMid: BiquadFilterNode;
  eqMid: BiquadFilterNode;
  eqHighMid: BiquadFilterNode;
  eqHigh: BiquadFilterNode;
  comp: DynamicsCompressorNode;
  analyserL: AnalyserNode;
  analyserR: AnalyserNode;
  monitorGain: GainNode;
};

class AudioEngine {
  ctx: AudioContext | null = null;
  masterNodes: MasterNodes | null = null;
  sources: Map<string, MediaElementAudioSourceNode> = new Map();
  videoElements: Map<string, HTMLMediaElement> = new Map();
  trackNodes: Map<string, TrackNodes> = new Map();
  
  trackDataArraysL: Map<string, Uint8Array<ArrayBuffer>> = new Map();
  trackDataArraysR: Map<string, Uint8Array<ArrayBuffer>> = new Map();
  masterDataArrayL: Uint8Array<ArrayBuffer> = new Uint8Array(0);
  masterDataArrayR: Uint8Array<ArrayBuffer> = new Uint8Array(0);

  init() {
    if (this.ctx) return;
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    this.ctx = new AudioContextClass();

    // Build master chain: MasterGain -> MasterEQ -> MasterComp -> MasterAnalyser -> destination
    const masterGain = this.ctx.createGain();

    const masterEqLow = this.ctx.createBiquadFilter();
    masterEqLow.type = 'lowshelf'; masterEqLow.frequency.value = 80;
    const masterEqLowMid = this.ctx.createBiquadFilter();
    masterEqLowMid.type = 'peaking'; masterEqLowMid.frequency.value = 300; masterEqLowMid.Q.value = 1.0;
    const masterEqMid = this.ctx.createBiquadFilter();
    masterEqMid.type = 'peaking'; masterEqMid.frequency.value = 1000; masterEqMid.Q.value = 1.0;
    const masterEqHighMid = this.ctx.createBiquadFilter();
    masterEqHighMid.type = 'peaking'; masterEqHighMid.frequency.value = 4000; masterEqHighMid.Q.value = 1.0;
    const masterEqHigh = this.ctx.createBiquadFilter();
    masterEqHigh.type = 'highshelf'; masterEqHigh.frequency.value = 12000;

    const masterPanner = this.ctx.createStereoPanner();

    const masterComp = this.ctx.createDynamicsCompressor();
    masterComp.threshold.value = DEFAULT_MASTER_STATE.comp.threshold;
    masterComp.ratio.value = DEFAULT_MASTER_STATE.comp.ratio;
    masterComp.attack.value = DEFAULT_MASTER_STATE.comp.attack;
    masterComp.release.value = DEFAULT_MASTER_STATE.comp.release;
    masterComp.knee.value = DEFAULT_MASTER_STATE.comp.knee;

    const splitter = this.ctx.createChannelSplitter(2);
    const masterAnalyserL = this.ctx.createAnalyser();
    const masterAnalyserR = this.ctx.createAnalyser();
    masterAnalyserL.fftSize = 2048;
    masterAnalyserR.fftSize = 2048;
    this.masterDataArrayL = new Uint8Array(masterAnalyserL.fftSize);
    this.masterDataArrayR = new Uint8Array(masterAnalyserR.fftSize);

    masterGain.connect(masterEqLow);
    masterEqLow.connect(masterEqLowMid);
    masterEqLowMid.connect(masterEqMid);
    masterEqMid.connect(masterEqHighMid);
    masterEqHighMid.connect(masterEqHigh);
    masterEqHigh.connect(masterPanner);
    masterPanner.connect(masterComp);
    
    const monitorGain = this.ctx.createGain();
    
    // Route to destination via monitorGain
    masterComp.connect(monitorGain);
    monitorGain.connect(this.ctx.destination);
    
    // Route to splitters for metering
    masterComp.connect(splitter);
    splitter.connect(masterAnalyserL, 0);
    splitter.connect(masterAnalyserR, 1);

    this.masterNodes = {
      gain: masterGain,
      panner: masterPanner,
      eqLow: masterEqLow, eqLowMid: masterEqLowMid,
      eqMid: masterEqMid, eqHighMid: masterEqHighMid,
      eqHigh: masterEqHigh,
      comp: masterComp,
      analyserL: masterAnalyserL,
      analyserR: masterAnalyserR,
      monitorGain: monitorGain
    };
  }

  async resume() {
    if (!this.ctx) this.init();
    if (this.ctx?.state === 'suspended') await this.ctx.resume();
  }

  getLatencySeconds(): number {
    if (!this.ctx) return 0;
    const base = this.ctx.baseLatency || 0.05;
    const output = this.ctx.outputLatency || 0.02;
    return base + output;
  }

  removeTrack(id: string) {
    if (this.sources.has(id)) {
      try { this.sources.get(id)!.disconnect(); } catch (_) { }
      this.sources.delete(id);
    }
    const nodes = this.trackNodes.get(id);
    if (nodes) {
      try { nodes.gain.disconnect(); } catch (_) { }
      try { nodes.panner.disconnect(); } catch (_) { }
      try { nodes.eqLow.disconnect(); } catch (_) { }
      try { nodes.eqLowMid.disconnect(); } catch (_) { }
      try { nodes.eqMid.disconnect(); } catch (_) { }
      try { nodes.eqHighMid.disconnect(); } catch (_) { }
      try { nodes.eqHigh.disconnect(); } catch (_) { }
      try { nodes.comp.disconnect(); } catch (_) { }
      try { nodes.analyserL.disconnect(); } catch (_) { }
      try { nodes.analyserR.disconnect(); } catch (_) { }
      this.trackNodes.delete(id);
    }
    this.videoElements.delete(id);
    this.trackDataArraysL.delete(id);
    this.trackDataArraysR.delete(id);
  }

  connectVideo(id: string, video: HTMLMediaElement) {
    if (!this.ctx) this.init();
    const existingVideo = this.videoElements.get(id);
    if (existingVideo === video && this.sources.has(id)) return;

    if (this.sources.has(id)) {
      this.removeTrack(id);
    }

    try {
      const source = this.ctx!.createMediaElementSource(video);

      // Build per-track chain: source -> comp -> 5xEQ -> panner -> gain -> analyser -> masterGain
      const comp = this.ctx!.createDynamicsCompressor();

      const eqLow = this.ctx!.createBiquadFilter();
      eqLow.type = 'lowshelf'; eqLow.frequency.value = 80;
      const eqLowMid = this.ctx!.createBiquadFilter();
      eqLowMid.type = 'peaking'; eqLowMid.frequency.value = 300; eqLowMid.Q.value = 1.0;
      const eqMid = this.ctx!.createBiquadFilter();
      eqMid.type = 'peaking'; eqMid.frequency.value = 1000; eqMid.Q.value = 1.0;
      const eqHighMid = this.ctx!.createBiquadFilter();
      eqHighMid.type = 'peaking'; eqHighMid.frequency.value = 4000; eqHighMid.Q.value = 1.0;
      const eqHigh = this.ctx!.createBiquadFilter();
      eqHigh.type = 'highshelf'; eqHigh.frequency.value = 12000;

      const panner = this.ctx!.createStereoPanner();
      const gain = this.ctx!.createGain();

      const splitter = this.ctx!.createChannelSplitter(2);
      const analyserL = this.ctx!.createAnalyser();
      const analyserR = this.ctx!.createAnalyser();
      analyserL.fftSize = 2048;
      analyserR.fftSize = 2048;
      
      const dataArrayL = new Uint8Array(analyserL.fftSize);
      const dataArrayR = new Uint8Array(analyserR.fftSize);
      this.trackDataArraysL.set(id, dataArrayL);
      this.trackDataArraysR.set(id, dataArrayR);

      source.connect(comp);
      comp.connect(eqLow);
      eqLow.connect(eqLowMid);
      eqLowMid.connect(eqMid);
      eqMid.connect(eqHighMid);
      eqHighMid.connect(eqHigh);
      eqHigh.connect(panner);
      panner.connect(gain);
      gain.connect(this.masterNodes!.gain);
      
      gain.connect(splitter);
      splitter.connect(analyserL, 0);
      splitter.connect(analyserR, 1);

      this.sources.set(id, source);
      this.videoElements.set(id, video);
      this.trackNodes.set(id, { gain, panner, eqLow, eqLowMid, eqMid, eqHighMid, eqHigh, comp, analyserL, analyserR });
    } catch (err) {
      console.error('Failed to connect audio source for', id, err);
    }
  }

  updateTrackState(id: string, state: TrackAudioState, anySoloed: boolean = false) {
    const nodes = this.trackNodes.get(id);
    if (!nodes || !this.ctx) return;
    const t = this.ctx.currentTime;

    nodes.panner.pan.value = state.pan;

    // 5-band EQ
    nodes.eqLow.gain.setTargetAtTime(state.eq.low, t, 0.05);
    nodes.eqLowMid.gain.setTargetAtTime(state.eq.lowMid, t, 0.05);
    nodes.eqMid.gain.setTargetAtTime(state.eq.mid, t, 0.05);
    nodes.eqHighMid.gain.setTargetAtTime(state.eq.highMid, t, 0.05);
    nodes.eqHigh.gain.setTargetAtTime(state.eq.high, t, 0.05);

    // Compressor
    nodes.comp.threshold.setTargetAtTime(state.comp.threshold, t, 0.05);
    nodes.comp.ratio.setTargetAtTime(state.comp.ratio, t, 0.05);
    nodes.comp.attack.setTargetAtTime(state.comp.attack, t, 0.05);
    nodes.comp.release.setTargetAtTime(state.comp.release, t, 0.05);
    nodes.comp.knee.setTargetAtTime(state.comp.knee, t, 0.05);

    // Mono downmix
    if (state.isMono) {
      nodes.gain.channelCountMode = 'explicit';
      nodes.gain.channelCount = 1;
    } else {
      nodes.gain.channelCountMode = 'max';
      nodes.gain.channelCount = 2;
    }

    const isMutedEffective = !state.isSoloed && (state.isMuted || anySoloed);
    nodes.gain.gain.setTargetAtTime(isMutedEffective ? 0 : state.volume, t, 0.05);
  }

  updateMasterState(state: MasterAudioState) {
    const nodes = this.masterNodes;
    if (!nodes || !this.ctx) return;
    const t = this.ctx.currentTime;

    nodes.panner.pan.value = state.pan;

    if (state.isMono) {
      nodes.gain.channelCountMode = 'explicit';
      nodes.gain.channelCount = 1;
    } else {
      nodes.gain.channelCountMode = 'max';
      nodes.gain.channelCount = 2;
    }

    nodes.gain.gain.setTargetAtTime(state.volume, t, 0.05);

    nodes.eqLow.gain.setTargetAtTime(state.eq.low, t, 0.05);
    nodes.eqLowMid.gain.setTargetAtTime(state.eq.lowMid, t, 0.05);
    nodes.eqMid.gain.setTargetAtTime(state.eq.mid, t, 0.05);
    nodes.eqHighMid.gain.setTargetAtTime(state.eq.highMid, t, 0.05);
    nodes.eqHigh.gain.setTargetAtTime(state.eq.high, t, 0.05);

    nodes.comp.threshold.setTargetAtTime(state.comp.threshold, t, 0.05);
    nodes.comp.ratio.setTargetAtTime(state.comp.ratio, t, 0.05);
    nodes.comp.attack.setTargetAtTime(state.comp.attack, t, 0.05);
    nodes.comp.release.setTargetAtTime(state.comp.release, t, 0.05);
    nodes.comp.knee.setTargetAtTime(state.comp.knee, t, 0.05);
  }

  setMasterVolume(vol: number) {
    if (this.masterNodes && this.ctx) {
      this.masterNodes.monitorGain.gain.setTargetAtTime(vol, this.ctx.currentTime, 0.05);
    }
  }

  getTrackMeterLevel(id: string): { l: number, r: number } {
    const nodes = this.trackNodes.get(id);
    const dataArrayL = this.trackDataArraysL.get(id);
    const dataArrayR = this.trackDataArraysR.get(id);
    if (!nodes || !dataArrayL || !dataArrayR) return { l: 0, r: 0 };
    
    // getByteTimeDomainData returns waveform samples (0-255, center=128)
    // RMS of (sample - 128) gives true signal amplitude
    nodes.analyserL.getByteTimeDomainData(dataArrayL);
    nodes.analyserR.getByteTimeDomainData(dataArrayR);
    
    let sumSqL = 0, sumSqR = 0;
    for (let i = 0; i < dataArrayL.length; i++) {
      const vL = (dataArrayL[i] - 128) / 128.0;
      const vR = (dataArrayR[i] - 128) / 128.0;
      sumSqL += vL * vL;
      sumSqR += vR * vR;
    }
    return {
      l: Math.sqrt(sumSqL / dataArrayL.length),
      r: Math.sqrt(sumSqR / dataArrayR.length)
    };
  }

  getTrackGRLevel(id: string): number {
    const nodes = this.trackNodes.get(id);
    if (!nodes) return 0;
    return Math.abs(nodes.comp.reduction);
  }

  getMasterMeterLevel(): { l: number, r: number } {
    if (!this.masterNodes) return { l: 0, r: 0 };
    
    this.masterNodes.analyserL.getByteTimeDomainData(this.masterDataArrayL);
    this.masterNodes.analyserR.getByteTimeDomainData(this.masterDataArrayR);
    
    let sumSqL = 0, sumSqR = 0;
    for (let i = 0; i < this.masterDataArrayL.length; i++) {
      const vL = (this.masterDataArrayL[i] - 128) / 128.0;
      const vR = (this.masterDataArrayR[i] - 128) / 128.0;
      sumSqL += vL * vL;
      sumSqR += vR * vR;
    }
    return {
      l: Math.sqrt(sumSqL / this.masterDataArrayL.length),
      r: Math.sqrt(sumSqR / this.masterDataArrayR.length)
    };
  }

  getMasterGRLevel(): number {
    if (!this.masterNodes) return 0;
    return Math.abs(this.masterNodes.comp.reduction);
  }

  // Legacy compat
  getMeterLevel(): number { return Math.max(this.getMasterMeterLevel().l, this.getMasterMeterLevel().r); }
}

export const audioEngine = new AudioEngine();
