import type { TrackAudioState, MasterAudioState, CompState, EQState } from './types';
import { PlaybackEngine } from './PlaybackEngine';

// EQ バンド定義（周波数順）。両端をシェルビング、中間をピーキングにする。
// バンドを増減する場合はこの配列を編集するだけでよい（UI・処理とも自動追従）。
export interface EQBand { freq: number; type: BiquadFilterType; q: number; label: string }
export const EQ_BANDS: EQBand[] = [
  { freq: 50,   type: 'lowshelf',  q: 0.7, label: '50' },
  { freq: 120,  type: 'peaking',   q: 1.0, label: '120' },
  { freq: 300,  type: 'peaking',   q: 1.0, label: '300' },
  { freq: 700,  type: 'peaking',   q: 1.0, label: '700' },
  { freq: 1600, type: 'peaking',   q: 1.0, label: '1.6k' },
  { freq: 3500, type: 'peaking',   q: 1.0, label: '3.5k' },
  { freq: 7000, type: 'highshelf', q: 0.7, label: '7k' },
];
export const DEFAULT_EQ: EQState = EQ_BANDS.map(() => 0);
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
  eq: [...DEFAULT_EQ],
  eqEnabled: false,
  comp: { ...DEFAULT_COMP },
  compEnabled: false,
};
export const DEFAULT_MASTER_STATE: MasterAudioState = {
  volume: 1.0,
  pan: 0,
  isMono: false,
  eq: [...DEFAULT_EQ],
  eqEnabled: false,
  comp: { ...DEFAULT_COMP, threshold: -6, ratio: 1.5 },
  compEnabled: false,
};

type TrackNodes = {
  gain: GainNode;
  panner: StereoPannerNode;
  eqBands: BiquadFilterNode[];
  comp: DynamicsCompressorNode;
  analyserL: AnalyserNode;
  analyserR: AnalyserNode;
};

type MasterNodes = {
  gain: GainNode;        // トラックの合算入力（サミングバス, gain=1固定）
  panner: StereoPannerNode;
  eqBands: BiquadFilterNode[];
  comp: DynamicsCompressorNode;
  fader: GainNode;       // マスターフェーダー（音量+モノ）。チェーンの最後に置く
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

  // チャンク再生エンジン（DAW式・サンプル精度のマルチトラック同期）
  readonly playback = new PlaybackEngine(
    () => this.getContext(),
    (id: string) => this.getTrackInputNode(id),
  );
  
  trackDataArraysL: Map<string, Uint8Array<ArrayBuffer>> = new Map();
  trackDataArraysR: Map<string, Uint8Array<ArrayBuffer>> = new Map();
  masterDataArrayL: Uint8Array<ArrayBuffer> = new Uint8Array(0);
  masterDataArrayR: Uint8Array<ArrayBuffer> = new Uint8Array(0);

  // EQ_BANDS 定義に従って直列の BiquadFilter チェーンを生成する
  private createEqBands(): BiquadFilterNode[] {
    return EQ_BANDS.map(band => {
      const f = this.ctx!.createBiquadFilter();
      f.type = band.type;
      f.frequency.value = band.freq;
      if (band.type === 'peaking') f.Q.value = band.q;
      return f;
    });
  }

  init() {
    if (this.ctx) return;
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    // 再生用PCM(48kHz)と一致させ、チャンクバッファのリサンプルを避ける
    try {
      this.ctx = new AudioContextClass({ sampleRate: 48000 });
    } catch {
      this.ctx = new AudioContextClass();
    }

    // Build master chain: MasterGain -> MasterEQ -> MasterComp -> MasterAnalyser -> destination
    const masterGain = this.ctx.createGain();

    const masterEqBands = this.createEqBands();

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

    // マスターフェーダー（音量+モノ）。フェーダーは最後（comp の後ろ）に置く
    const masterFader = this.ctx.createGain();

    // チェーン: masterGain(sum) -> [EQ bands...] -> panner -> comp -> fader
    let mprev: AudioNode = masterGain;
    for (const b of masterEqBands) { mprev.connect(b); mprev = b; }
    mprev.connect(masterPanner);
    masterPanner.connect(masterComp);
    masterComp.connect(masterFader);

    const monitorGain = this.ctx.createGain();

    // Route to destination via monitorGain（フェーダー後）
    masterFader.connect(monitorGain);
    monitorGain.connect(this.ctx.destination);

    // Route to splitters for metering（ポストフェーダー計測）
    masterFader.connect(splitter);
    splitter.connect(masterAnalyserL, 0);
    splitter.connect(masterAnalyserR, 1);

    this.masterNodes = {
      gain: masterGain,
      panner: masterPanner,
      eqBands: masterEqBands,
      comp: masterComp,
      fader: masterFader,
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
      nodes.eqBands.forEach(b => { try { b.disconnect(); } catch (_) { } });
      try { nodes.comp.disconnect(); } catch (_) { }
      try { nodes.analyserL.disconnect(); } catch (_) { }
      try { nodes.analyserR.disconnect(); } catch (_) { }
      this.trackNodes.delete(id);
    }
    this.videoElements.delete(id);
    this.trackDataArraysL.delete(id);
    this.trackDataArraysR.delete(id);
  }

  // ソースを除いた per-track 処理チェーンを構築する（comp -> EQ -> panner -> gain -> master ＋ メータ）。
  // チャンク再生のソースは comp に接続する。
  private buildTrackChain(id: string): TrackNodes {
    const comp = this.ctx!.createDynamicsCompressor();
    const eqBands = this.createEqBands();
    const panner = this.ctx!.createStereoPanner();
    const gain = this.ctx!.createGain();

    const splitter = this.ctx!.createChannelSplitter(2);
    const analyserL = this.ctx!.createAnalyser();
    const analyserR = this.ctx!.createAnalyser();
    analyserL.fftSize = 2048;
    analyserR.fftSize = 2048;
    this.trackDataArraysL.set(id, new Uint8Array(analyserL.fftSize));
    this.trackDataArraysR.set(id, new Uint8Array(analyserR.fftSize));

    // comp -> [EQ bands...] -> panner -> gain -> master
    let prev: AudioNode = comp;
    for (const b of eqBands) { prev.connect(b); prev = b; }
    prev.connect(panner);
    panner.connect(gain);
    gain.connect(this.masterNodes!.gain);
    gain.connect(splitter);
    splitter.connect(analyserL, 0);
    splitter.connect(analyserR, 1);

    const nodes: TrackNodes = { gain, panner, eqBands, comp, analyserL, analyserR };
    this.trackNodes.set(id, nodes);
    return nodes;
  }

  // チャンク再生(バッファ)用にトラックチェーンを用意する（メディア要素ソースは作らない）
  ensureTrackChain(id: string): void {
    if (!this.ctx) this.init();
    if (this.trackNodes.has(id)) return;
    this.buildTrackChain(id);
  }

  // チャンク再生ソースの接続先（= comp）。PlaybackEngine から使う
  getTrackInputNode(id: string): AudioNode | null {
    return this.trackNodes.get(id)?.comp ?? null;
  }

  getContext(): AudioContext | null {
    if (!this.ctx) this.init();
    return this.ctx;
  }

  updateTrackState(id: string, state: TrackAudioState, anySoloed: boolean = false) {
    const nodes = this.trackNodes.get(id);
    if (!nodes || !this.ctx) return;
    const t = this.ctx.currentTime;

    nodes.panner.pan.value = state.pan;

    // EQ（eqEnabled=false のときは全バンドを 0dB にしてバイパス）
    const eq = state.eqEnabled !== false ? state.eq : DEFAULT_EQ;
    nodes.eqBands.forEach((b, i) => b.gain.setTargetAtTime(eq[i] ?? 0, t, 0.05));

    // Compressor (compEnabled=false のときは ratio=1 / threshold=0 でバイパス)
    const comp = state.compEnabled !== false ? state.comp : { ...state.comp, ratio: 1, threshold: 0 };
    nodes.comp.threshold.setTargetAtTime(comp.threshold, t, 0.05);
    nodes.comp.ratio.setTargetAtTime(comp.ratio, t, 0.05);
    nodes.comp.attack.setTargetAtTime(comp.attack, t, 0.05);
    nodes.comp.release.setTargetAtTime(comp.release, t, 0.05);
    nodes.comp.knee.setTargetAtTime(comp.knee, t, 0.05);

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

    // 音量・モノはフェーダー(チェーン最後)に適用。サミング入力(gain)は 1.0 固定のまま
    if (state.isMono) {
      nodes.fader.channelCountMode = 'explicit';
      nodes.fader.channelCount = 1;
    } else {
      nodes.fader.channelCountMode = 'max';
      nodes.fader.channelCount = 2;
    }

    nodes.fader.gain.setTargetAtTime(state.volume, t, 0.05);

    const meq = state.eqEnabled !== false ? state.eq : DEFAULT_EQ;
    nodes.eqBands.forEach((b, i) => b.gain.setTargetAtTime(meq[i] ?? 0, t, 0.05));

    const mcomp = state.compEnabled !== false ? state.comp : { ...state.comp, ratio: 1, threshold: 0 };
    nodes.comp.threshold.setTargetAtTime(mcomp.threshold, t, 0.05);
    nodes.comp.ratio.setTargetAtTime(mcomp.ratio, t, 0.05);
    nodes.comp.attack.setTargetAtTime(mcomp.attack, t, 0.05);
    nodes.comp.release.setTargetAtTime(mcomp.release, t, 0.05);
    nodes.comp.knee.setTargetAtTime(mcomp.knee, t, 0.05);
  }

  setMasterVolume(vol: number) {
    if (this.masterNodes && this.ctx) {
      this.masterNodes.monitorGain.gain.setTargetAtTime(vol, this.ctx.currentTime, 0.05);
    }
  }

  getTrackMeterLevel(id: string, isMono = false): { l: number, r: number } {
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
    const l = Math.sqrt(sumSqL / dataArrayL.length);
    // モノ時は gain.channelCount=1 のため splitter の R チャンネルが無音になる
    // その場合は L の値を R にも使う
    const r = isMono ? l : Math.sqrt(sumSqR / dataArrayR.length);
    return { l, r };
  }

  getTrackGRLevel(id: string): number {
    const nodes = this.trackNodes.get(id);
    if (!nodes) return 0;
    return Math.abs(nodes.comp.reduction);
  }

  getMasterMeterLevel(isMono = false): { l: number, r: number } {
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
    const l = Math.sqrt(sumSqL / this.masterDataArrayL.length);
    // モノ時は fader.channelCount=1 のため splitter の R が無音になる
    const r = isMono ? l : Math.sqrt(sumSqR / this.masterDataArrayR.length);
    return { l, r };
  }

  getMasterGRLevel(): number {
    if (!this.masterNodes) return 0;
    return Math.abs(this.masterNodes.comp.reduction);
  }

  // Legacy compat
  getMeterLevel(): number { return Math.max(this.getMasterMeterLevel().l, this.getMasterMeterLevel().r); }
}

export const audioEngine = new AudioEngine();
