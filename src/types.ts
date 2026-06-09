export type TransitionType = 'cut' | 'crossfade' | 'dip_to_black' | 'dip_to_white';

export interface CutPoint {
  id: string;
  timeSeconds: number;
  cameraId: string; // The ID of the track we switch to
  transition: TransitionType;
  transitionDuration: number;
}

// 各バンドのゲイン(dB)の配列。インデックスは AudioEngine.EQ_BANDS と対応する
export type EQState = number[];

export interface CompState {
  threshold: number; // dB, -60 to 0
  ratio: number;     // 1 to 20
  attack: number;    // seconds, 0.0 to 1.0
  release: number;   // seconds, 0.0 to 1.0
  knee: number;      // dB, 0 to 40
}

export interface TrackAudioState {
  volume: number; // 0.0 to 1.0
  pan: number;    // -1.0 to 1.0
  isMono: boolean;
  isMuted: boolean;
  isSoloed: boolean;
  eq: EQState;
  eqEnabled: boolean;
  comp: CompState;
  compEnabled: boolean;
}

export interface MasterAudioState {
  volume: number;
  pan: number;
  isMono: boolean;
  eq: EQState;
  eqEnabled: boolean;
  comp: CompState;
  compEnabled: boolean;
}

export interface ColorState {
  temperature: number; // 色温度: -100 (青) 〜 100 (黄)
  tint: number;        // 色合い: -100 (緑) 〜 100 (マゼンタ)
  exposure: number;    // 露出/明るさ: -100 (暗) 〜 100 (明)
  contrast: number;    // コントラスト: -100 (低) 〜 100 (高)
}

export const DEFAULT_COLOR_STATE: ColorState = {
  temperature: 0,
  tint: 0,
  exposure: 0,
  contrast: 0
};

export interface TrackData {
  id: string;
  name: string;
  color?: string;
  path: string;
  wavPath: string;
  peaks: number[];
  offsetSeconds: number;
  isRef: boolean;
  audioState: TrackAudioState;
  lastAutoSyncedOffset?: number;
  isAudioOnly?: boolean;
  isLocked?: boolean;
  audioOffsetSeconds?: number;
  colorState?: ColorState;
}

export interface ExportSettings {
  resolution: string;
  encoder: string;
  rateControl: 'cbr' | 'vbr' | 'crf';
  bitrate?: string;   // cbr/vbr時のみ使用
  maxrate?: string;   // vbr時のみ使用
  crfValue?: number;  // crf時のみ使用
  fps: string;
  audioQuality?: 'standard' | 'high' | 'lossless';
  loudnorm: boolean;
  outputPath: string;
  startTimeSeconds?: number;
  endTimeSeconds?: number;
  fadeIn?: boolean;
  fadeInDuration?: number;
  fadeOut?: boolean;
  fadeOutDuration?: number;
}

export interface ExportRange {
  start: number;
  end: number;
  useRange: boolean;
  fadeIn?: boolean;
  fadeInDuration?: number;
  fadeOut?: boolean;
  fadeOutDuration?: number;
}

export interface ExportPayload {
  tracks: TrackData[];
  cuts: CutPoint[];
  settings: ExportSettings;
  master: MasterAudioState;
}

// 縦スライダー用の非標準属性 `orient`（Firefox 等）を input で使えるよう型拡張する
declare module 'react' {
  interface InputHTMLAttributes<T> {
    orient?: string;
  }
}
