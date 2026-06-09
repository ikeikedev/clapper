import { invoke } from '@tauri-apps/api/core';

// ────────────────────────────────────────────────────────────────────────────
// チャンク再生エンジン（DAW式・ウィンドウ型スケジューリング）
//
// 各トラックの音声(フル品質PCM=WAV)を、再生位置の少し先だけ短いチャンク(既定10秒)に
// 切り出して AudioBuffer 化し、AudioBufferSourceNode で「同一 AudioContext クロック」に
// 隙間なく連続スケジュールする。これにより:
//   - 全トラックがサンプル精度で同期（ドリフトなし・レート変更なし・プツッなし）
//   - RAMに居るのは各トラック数十秒ぶんだけ（長尺でもメモリ一定）
//   - シークは予約中ソースを止めて目標位置から読み直すだけ
//
// AudioContext と「各トラックの入力ノード( chunk source の接続先 = comp)」は
// AudioEngine から借りる（ミキサーの EQ/コンプ/パン/メータを通すため）。
// ────────────────────────────────────────────────────────────────────────────

const CHUNK_SEC = 10;            // 1チャンクのコンテンツ長（秒）
const SCHEDULE_HORIZON_SEC = 22; // 再生ヘッドからこの秒数先まで常に予約しておく
const SCHED_TICK_MS = 200;       // スケジューラの監視間隔

interface WavInfo {
  dataOffset: number;   // PCMデータ開始バイト
  dataBytes: number;    // PCMデータ総バイト
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
}

interface ScheduledChunk {
  src: AudioBufferSourceNode;
  startCtx: number; // このチャンクが鳴り始める ctx.currentTime
  endCtx: number;   // 鳴り終わる ctx.currentTime
}

interface PETrack {
  id: string;
  path: string;
  wav: WavInfo;
  durationSec: number;
  totalOffsetSec: number; // コンテンツ位置 = mediaTime - totalOffsetSec
  active: boolean;        // スケジュール対象か（聞こえる＝ミュートでないトラックのみ）
  // スケジューリング状態
  nextContentSec: number; // 次に予約すべきコンテンツ開始秒
  scheduled: ScheduledChunk[];
  loadingUntilSec: number; // 読み込み中の先頭境界（多重読み防止）
  generation: number;      // シーク等で無効化するための世代カウンタ
}

// 16bit PCM のリトルエンディアン ArrayBuffer をチャンネル別 Float32 に展開
function pcm16ToFloat32(buf: ArrayBuffer, channels: number): Float32Array<ArrayBuffer>[] {
  const view = new DataView(buf);
  const totalSamples = Math.floor(buf.byteLength / 2);
  const frames = Math.floor(totalSamples / channels);
  const out: Float32Array<ArrayBuffer>[] = [];
  for (let c = 0; c < channels; c++) out.push(new Float32Array(frames));
  let i = 0;
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < channels; c++) {
      const s = view.getInt16(i * 2, true);
      out[c][f] = s / 32768;
      i++;
    }
  }
  return out;
}

// WAV ヘッダを解析して data チャンク位置・フォーマットを得る（FFmpeg出力のメタチャンクにも対応）
function parseWavHeader(buf: ArrayBuffer): WavInfo | null {
  const view = new DataView(buf);
  const ascii = (off: number, len: number) => {
    let s = '';
    for (let i = 0; i < len; i++) s += String.fromCharCode(view.getUint8(off + i));
    return s;
  };
  if (ascii(0, 4) !== 'RIFF' || ascii(8, 4) !== 'WAVE') return null;
  let pos = 12;
  let sampleRate = 48000, channels = 2, bitsPerSample = 16;
  while (pos + 8 <= buf.byteLength) {
    const id = ascii(pos, 4);
    const size = view.getUint32(pos + 4, true);
    const body = pos + 8;
    if (id === 'fmt ') {
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bitsPerSample = view.getUint16(body + 14, true);
    } else if (id === 'data') {
      return { dataOffset: body, dataBytes: size, sampleRate, channels, bitsPerSample };
    }
    pos = body + size + (size % 2); // チャンクは偶数境界
  }
  return null;
}

export class PlaybackEngine {
  private getCtx: () => AudioContext | null;
  private getInput: (id: string) => AudioNode | null;
  private tracks = new Map<string, PETrack>();

  private _playing = false;
  private anchorCtxTime = 0;   // 再生開始時の ctx.currentTime
  private anchorMediaTime = 0; // 再生開始時の メディア時刻
  private pausedMediaTime = 0; // 停止中の メディア時刻
  private schedTimer: number | null = null;
  private onEnded?: (mediaTime: number) => void;

  constructor(getCtx: () => AudioContext | null, getInput: (id: string) => AudioNode | null) {
    this.getCtx = getCtx;
    this.getInput = getInput;
  }

  setOnEnded(cb: (mediaTime: number) => void) { this.onEnded = cb; }

  get playing() { return this._playing; }

  // 現在のメディア再生位置（秒）
  getPlayheadTime(): number {
    const ctx = this.getCtx();
    if (!this._playing || !ctx) return this.pausedMediaTime;
    return this.anchorMediaTime + (ctx.currentTime - this.anchorCtxTime);
  }

  // トラックの再生用PCMを登録（ヘッダ解析のみ。実データはチャンク時に読む）
  async loadTrack(id: string, path: string, totalOffsetSec: number, active: boolean): Promise<number> {
    const headBuf = await this.readRange(path, 0, 8192);
    const wav = parseWavHeader(headBuf);
    if (!wav) throw new Error(`WAVヘッダの解析に失敗: ${path}`);
    const bytesPerSec = wav.sampleRate * wav.channels * (wav.bitsPerSample / 8);
    const durationSec = wav.dataBytes / bytesPerSec;
    this.tracks.set(id, {
      id, path, wav, durationSec, totalOffsetSec, active,
      nextContentSec: 0, scheduled: [], loadingUntilSec: -1, generation: 0,
    });
    return durationSec;
  }

  removeTrack(id: string) {
    const t = this.tracks.get(id);
    if (t) { this.stopTrackChunks(t); this.tracks.delete(id); }
  }

  // 全トラックを解除して停止する（新規プロジェクト/プロジェクト読込前のクリア用）
  reset() {
    this.pause();
    for (const t of this.tracks.values()) this.stopTrackChunks(t);
    this.tracks.clear();
    this.pausedMediaTime = 0;
  }

  setTrackOffset(id: string, totalOffsetSec: number) {
    const t = this.tracks.get(id);
    if (!t || t.totalOffsetSec === totalOffsetSec) return;
    t.totalOffsetSec = totalOffsetSec;
    if (this._playing) this.rescheduleTrack(t);
  }

  setTrackActive(id: string, active: boolean) {
    const t = this.tracks.get(id);
    if (!t || t.active === active) return;
    t.active = active;
    if (this._playing) {
      if (active) this.startTrackFrom(t, this.getPlayheadTime());
      else this.stopTrackChunks(t);
    }
  }

  // ── トランスポート ──────────────────────────────────────────────
  async play(fromMediaTime: number) {
    const ctx = this.getCtx();
    if (!ctx) return;
    if (ctx.state === 'suspended') { try { await ctx.resume(); } catch { /* noop */ } }
    this.stopAllChunks();
    this.anchorMediaTime = fromMediaTime;
    this.anchorCtxTime = ctx.currentTime;
    this._playing = true;
    for (const t of this.tracks.values()) {
      if (t.active) this.startTrackFrom(t, fromMediaTime);
    }
    this.startScheduler();
  }

  pause() {
    if (!this._playing) return;
    this.pausedMediaTime = this.getPlayheadTime();
    this._playing = false;
    this.stopScheduler();
    this.stopAllChunks();
  }

  seek(toMediaTime: number) {
    this.pausedMediaTime = toMediaTime;
    if (!this._playing) return;
    const ctx = this.getCtx();
    if (!ctx) return;
    // アンカーを貼り直して全トラックを新位置から組み直す
    this.anchorMediaTime = toMediaTime;
    this.anchorCtxTime = ctx.currentTime;
    this.stopAllChunks();
    for (const t of this.tracks.values()) {
      if (t.active) this.startTrackFrom(t, toMediaTime);
    }
  }

  // ── 内部: スケジューリング ───────────────────────────────────────
  private startTrackFrom(t: PETrack, mediaTime: number) {
    t.generation++;
    t.scheduled = [];
    t.loadingUntilSec = -1;
    // コンテンツ位置（負なら0開始＝それまでは無音）
    const content = mediaTime - t.totalOffsetSec;
    t.nextContentSec = Math.max(0, content);
    this.ensureScheduled(t);
  }

  private rescheduleTrack(t: PETrack) {
    this.stopTrackChunks(t);
    this.startTrackFrom(t, this.getPlayheadTime());
  }

  // 再生ヘッドから SCHEDULE_HORIZON_SEC 先までチャンクを予約する
  private ensureScheduled(t: PETrack) {
    const ctx = this.getCtx();
    if (!ctx || !this._playing || !t.active) return;
    if (t.nextContentSec >= t.durationSec) return; // 末尾まで予約済み

    const horizonContent = (this.getPlayheadTime() - t.totalOffsetSec) + SCHEDULE_HORIZON_SEC;
    if (t.nextContentSec > horizonContent) return; // 十分先まで予約済み
    if (t.loadingUntilSec === t.nextContentSec) return; // 既に読み込み中

    const contentStart = t.nextContentSec;
    t.loadingUntilSec = contentStart;
    const gen = t.generation;

    this.loadChunkBuffer(t, contentStart).then(buf => {
      // 世代が変わっていたら（シーク/オフセット変更/停止）破棄
      if (gen !== t.generation || !this._playing) return;
      const c = this.getCtx();
      const input = this.getInput(t.id);
      if (!buf || !c || !input) { t.loadingUntilSec = -1; return; }

      const src = c.createBufferSource();
      src.buffer = buf;
      src.connect(input);

      // このチャンクが鳴るべき ctx 時刻 = アンカー基準でコンテンツ位置から逆算
      const anchorContent = this.anchorMediaTime - t.totalOffsetSec;
      const ctxForContentStart = this.anchorCtxTime + (contentStart - anchorContent);
      const chunkDur = buf.duration;

      if (ctxForContentStart >= c.currentTime) {
        // まだ未来 → その時刻ちょうどに開始
        src.start(ctxForContentStart, 0);
        t.scheduled.push({ src, startCtx: ctxForContentStart, endCtx: ctxForContentStart + chunkDur });
      } else {
        // 既に過ぎている（再生開始/シーク直後の最初のチャンク）→ 今すぐ途中から
        const into = c.currentTime - ctxForContentStart;
        if (into < chunkDur) {
          src.start(c.currentTime, into);
          t.scheduled.push({ src, startCtx: c.currentTime, endCtx: ctxForContentStart + chunkDur });
        }
      }

      t.nextContentSec = contentStart + CHUNK_SEC;
      t.loadingUntilSec = -1;
      // 続けて先まで予約
      this.ensureScheduled(t);
    }).catch(() => { t.loadingUntilSec = -1; });
  }

  // contentStart から CHUNK_SEC ぶん（または末尾まで）の AudioBuffer を読み込む
  private async loadChunkBuffer(t: PETrack, contentStart: number): Promise<AudioBuffer | null> {
    const ctx = this.getCtx();
    if (!ctx) return null;
    const { sampleRate, channels, dataOffset, dataBytes } = t.wav;
    const bytesPerFrame = channels * 2;
    const startFrame = Math.floor(contentStart * sampleRate);
    const wantFrames = Math.ceil(CHUNK_SEC * sampleRate);
    const totalFrames = Math.floor(dataBytes / bytesPerFrame);
    if (startFrame >= totalFrames) return null;
    const frames = Math.min(wantFrames, totalFrames - startFrame);
    const byteStart = dataOffset + startFrame * bytesPerFrame;
    const byteLen = frames * bytesPerFrame;

    const raw = await this.readRange(t.path, byteStart, byteLen);
    const planar = pcm16ToFloat32(raw, channels);
    const realFrames = planar[0]?.length ?? 0;
    if (realFrames === 0) return null;
    // AudioBuffer は ctx と同じレートで作る（リサンプル回避のため抽出レート=ctxレートが前提）
    const buffer = ctx.createBuffer(channels, realFrames, sampleRate);
    for (let c = 0; c < channels; c++) buffer.copyToChannel(planar[c], c);
    return buffer;
  }

  private startScheduler() {
    if (this.schedTimer !== null) return;
    this.schedTimer = window.setInterval(() => {
      if (!this._playing) return;
      const head = this.getPlayheadTime();
      let allEnded = this.tracks.size > 0;
      for (const t of this.tracks.values()) {
        if (t.active) { this.ensureScheduled(t); this.pruneScheduled(t); }
        const content = head - t.totalOffsetSec;
        if (content < t.durationSec) allEnded = false;
      }
      if (allEnded && this.onEnded) this.onEnded(head);
    }, SCHED_TICK_MS);
  }

  private stopScheduler() {
    if (this.schedTimer !== null) { window.clearInterval(this.schedTimer); this.schedTimer = null; }
  }

  // 再生済みチャンクの参照を破棄（GCでメモリ解放。ノードは ended で自動切断）
  private pruneScheduled(t: PETrack) {
    const ctx = this.getCtx();
    if (!ctx) return;
    t.scheduled = t.scheduled.filter(s => s.endCtx > ctx.currentTime - 0.5);
  }

  private stopTrackChunks(t: PETrack) {
    t.generation++;
    for (const s of t.scheduled) { try { s.src.stop(); s.src.disconnect(); } catch { /* noop */ } }
    t.scheduled = [];
    t.loadingUntilSec = -1;
  }

  private stopAllChunks() {
    for (const t of this.tracks.values()) this.stopTrackChunks(t);
  }

  private async readRange(path: string, offset: number, length: number): Promise<ArrayBuffer> {
    const res = await invoke<ArrayBuffer>('read_pcm_range', { path, offset, length });
    // ipc::Response は ArrayBuffer として返る
    return res as ArrayBuffer;
  }
}
