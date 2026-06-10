import React, { useState, useEffect } from 'react';
import { save } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { TrackData, CutPoint, ExportSettings, ExportPayload, ExportRange, MasterAudioState } from './types';
import { formatTimecode } from './Timeline';

// ────────────────────────────────────────────────
// プリセット定義
// ────────────────────────────────────────────────

interface VideoSettings {
  resolution: string;
  fps: string;
  encoder: string;
  rateControl: 'cbr' | 'vbr' | 'crf';
  bitrate: string;
  maxrate: string;
  crfValue: number;
}

interface ExportPreset {
  id: string;
  label: string;
  settings?: Partial<VideoSettings>;
}

// ユーザーが保存するカスタムプリセット（映像設定＋音声設定をまとめて保持）
interface CustomPreset {
  id: string;
  label: string;
  video: VideoSettings;
  audioQuality: 'standard' | 'high' | 'lossless';
  loudnorm: boolean;
}

const CUSTOM_PRESETS_KEY = 'mcse_export_presets';

const EXPORT_PRESETS: ExportPreset[] = [
  {
    id: 'youtube_4k',
    label: 'YouTube 4K (2160p 60fps)',
    settings: { resolution: '3840x2160', fps: '60', encoder: 'auto', rateControl: 'vbr', bitrate: '40M', maxrate: '60M', crfValue: 18 }
  },
  {
    id: 'youtube_fhd60',
    label: 'YouTube フルHD (1080p 60fps)',
    settings: { resolution: '1920x1080', fps: '60', encoder: 'auto', rateControl: 'vbr', bitrate: '12M', maxrate: '18M', crfValue: 18 }
  },
  {
    id: 'youtube_fhd30',
    label: 'YouTube フルHD (1080p 30fps)',
    settings: { resolution: '1920x1080', fps: '30', encoder: 'auto', rateControl: 'vbr', bitrate: '8M', maxrate: '12M', crfValue: 18 }
  },
  {
    id: 'twitter',
    label: 'Twitter / X',
    settings: { resolution: '1920x1080', fps: '30', encoder: 'auto', rateControl: 'cbr', bitrate: '8M', maxrate: '8M', crfValue: 23 }
  },
  {
    id: 'archive',
    label: 'アーカイブ（高画質・CRF）',
    settings: { resolution: '1920x1080', fps: '60', encoder: 'libx264', rateControl: 'crf', bitrate: '20M', maxrate: '30M', crfValue: 18 }
  },
  {
    id: 'custom',
    label: 'カスタム'
  }
];

// ────────────────────────────────────────────────
// Props
// ────────────────────────────────────────────────

interface ExportModalProps {
  tracks: TrackData[];
  cuts: CutPoint[];
  duration: number;
  onClose: () => void;
  exportRange: ExportRange;
  projectFps: 24 | 29.97 | 30 | 60;
  masterState: MasterAudioState;
}

// ────────────────────────────────────────────────
// スタイル定数
// ────────────────────────────────────────────────

const selectStyle: React.CSSProperties = {
  flex: 1,
  padding: '7px 8px',
  background: '#1e293b',
  color: 'white',
  border: '1px solid #334155',
  borderRadius: '4px',
  outline: 'none',
  cursor: 'pointer',
  fontSize: '0.85rem'
};

const labelStyle: React.CSSProperties = {
  fontSize: '0.82rem',
  color: '#94a3b8',
  width: '120px',
  flexShrink: 0,
  display: 'flex',
  alignItems: 'center'
};

const rowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '10px'
};

// ────────────────────────────────────────────────
// Component
// ────────────────────────────────────────────────

export function ExportModal({
  tracks,
  cuts,
  duration,
  onClose,
  exportRange,
  projectFps,
  masterState,
}: ExportModalProps) {
  const [preset, setPreset] = useState('custom');
  const [video, setVideo] = useState<VideoSettings>({
    resolution: '1920x1080',
    fps: String(projectFps),
    encoder: 'auto',
    rateControl: 'cbr',
    bitrate: '8M',
    maxrate: '',
    crfValue: 18,
  });
  const [audioQuality, setAudioQuality] = useState<'standard' | 'high' | 'lossless'>('standard');
  const [loudnorm, setLoudnorm] = useState(true);
  // 書き出し範囲: 'range'=タイムラインで設定した In/Out 範囲、'full'=動画全体。
  // In/Out が未設定（useRange=false）の場合は範囲が無いので 'full' を既定にする。
  const [rangeMode, setRangeMode] = useState<'range' | 'full'>(exportRange.useRange ? 'range' : 'full');

  const [isExporting, setIsExporting] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [progress, setProgress] = useState(0);
  const [statusMsg, setStatusMsg] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [outputPath, setOutputPath] = useState<string | null>(null);

  // ユーザー保存のカスタムプリセット（localStorage に永続化）
  const [customPresets, setCustomPresets] = useState<CustomPreset[]>([]);
  useEffect(() => {
    const saved = localStorage.getItem(CUSTOM_PRESETS_KEY);
    if (saved) {
      try {
        const arr = JSON.parse(saved);
        if (Array.isArray(arr)) setCustomPresets(arr);
      } catch (e) {
        console.error('カスタムプリセットの読み込みに失敗しました', e);
      }
    }
  }, []);

  const handleOpenFolder = async () => {
    if (!outputPath) return;
    try {
      await invoke('reveal_in_explorer', { path: outputPath });
    } catch (e) {
      console.error('フォルダを開けませんでした', e);
    }
  };

  const applyPreset = (presetId: string) => {
    setPreset(presetId);
    const builtin = EXPORT_PRESETS.find(p => p.id === presetId);
    if (builtin?.settings) {
      setVideo(prev => ({ ...prev, ...builtin.settings }));
      return;
    }
    const custom = customPresets.find(p => p.id === presetId);
    if (custom) {
      setVideo({ ...custom.video });
      setAudioQuality(custom.audioQuality);
      setLoudnorm(custom.loudnorm);
    }
  };

  // プリセット名のインライン入力（window.prompt は WebView2 で動作保証がないため使わない）
  const [namingPreset, setNamingPreset] = useState(false);
  const [presetNameInput, setPresetNameInput] = useState('');

  const handleSavePreset = () => {
    setPresetNameInput('');
    setNamingPreset(true);
  };

  // 入力された名前で現在の設定をカスタムプリセットとして確定保存
  const confirmSavePreset = () => {
    const name = presetNameInput.trim();
    if (!name) return;
    const newPreset: CustomPreset = {
      id: `custom_${Date.now()}`,
      label: name,
      video: { ...video },
      audioQuality,
      loudnorm,
    };
    setCustomPresets(prev => {
      const next = [...prev, newPreset];
      localStorage.setItem(CUSTOM_PRESETS_KEY, JSON.stringify(next));
      return next;
    });
    setPreset(newPreset.id);
    setNamingPreset(false);
  };

  // 現在選択中のカスタムプリセットを削除
  const handleDeletePreset = () => {
    if (!customPresets.some(p => p.id === preset)) return;
    setCustomPresets(prev => {
      const next = prev.filter(p => p.id !== preset);
      localStorage.setItem(CUSTOM_PRESETS_KEY, JSON.stringify(next));
      return next;
    });
    setPreset('custom');
  };

  const isCustomPresetSelected = customPresets.some(p => p.id === preset);

  const updateVideo = <K extends keyof VideoSettings>(key: K, value: VideoSettings[K]) => {
    setPreset('custom');
    setVideo(prev => ({ ...prev, [key]: value }));
  };

  const handleExport = async () => {
    if (tracks.length === 0) return;
    let unlisten: (() => void) | undefined;
    let unlistenStatus: (() => void) | undefined;
    try {
      const savePath = await save({
        filters: [{ name: 'Video', extensions: ['mp4'] }],
        defaultPath: 'output.mp4'
      });
      if (!savePath) return;

      setIsExporting(true);
      setIsCancelling(false);
      setErrorMsg('');
      setOutputPath(savePath);
      setStatusMsg('FFmpegコマンドを生成中...');
      setProgress(0);

      // 「設定した範囲」かつ実際に In/Out が設定済みのときだけ範囲トリミングを行う。
      // 「全範囲」選択時は範囲・フェードを無効化して動画全体を書き出す。
      const useRange = rangeMode === 'range' && exportRange.useRange;
      const startTime = exportRange.start;
      const endTime = exportRange.end;

      const settings: ExportSettings = {
        resolution: video.resolution,
        fps: video.fps,
        encoder: video.encoder,
        rateControl: video.rateControl,
        bitrate: video.rateControl !== 'crf' ? video.bitrate : undefined,
        maxrate: video.rateControl === 'vbr' && video.maxrate ? video.maxrate : undefined,
        crfValue: video.rateControl === 'crf' ? video.crfValue : undefined,
        audioQuality,
        loudnorm,
        outputPath: savePath,
        startTimeSeconds: useRange ? startTime : undefined,
        endTimeSeconds: useRange ? endTime : undefined,
        fadeIn: useRange ? exportRange.fadeIn : false,
        fadeInDuration: useRange ? exportRange.fadeInDuration : 0.5,
        fadeOut: useRange ? exportRange.fadeOut : false,
        fadeOutDuration: useRange ? exportRange.fadeOutDuration : 0.5,
      };

      // ソロ状態を書き出しに反映: ソロ中のトラックがあれば実効的にミュート状態に変換する
      const anySoloed = tracks.some(t => t.audioState.isSoloed);
      const exportTracks = anySoloed
        ? tracks.map(t => ({
            ...t,
            audioState: {
              ...t.audioState,
              isMuted: !t.audioState.isSoloed
            }
          }))
        : tracks;

      const payload: ExportPayload = { tracks: exportTracks, cuts, settings, master: masterState };

      unlisten = await listen<number>('export-progress', event => {
        setProgress(event.payload);
        setStatusMsg(`エンコード中... ${Math.round(event.payload)}%`);
      });
      // バックエンド側の準備段階（動画解析・フィルター構築・エンコーダー検出・FFmpeg起動）の
      // 進行状況を表示する。ここで止まる場合、どの段階で詰まっているかの切り分けに使う。
      unlistenStatus = await listen<string>('export-status', event => {
        setStatusMsg(event.payload);
      });

      await invoke('export_video', { payload });
      setStatusMsg('エンコード完了！');
      setProgress(100);
      // フォルダは自動では開かない（完了画面の「出力フォルダを開く」ボタンに委ねる）
    } catch (err) {
      console.error(err);
      // ユーザーがキャンセルした場合は「エラー」ではなく設定画面へ戻す
      if (String(err).includes('EXPORT_CANCELLED')) {
        setStatusMsg('書き出しをキャンセルしました');
        setIsExporting(false);
      } else {
        // エラー内容（FFmpegログ末尾・ログファイルパスを含む）を専用画面で表示し続ける。
        // ここで isExporting を false にすると設定画面へ戻ってしまい、エラーが見えなくなるため維持する。
        setErrorMsg(String(err));
      }
      setIsCancelling(false);
    } finally {
      unlisten?.();
      unlistenStatus?.();
    }
  };

  const handleCancelExport = async () => {
    setIsCancelling(true);
    setStatusMsg('キャンセル中...');
    try {
      await invoke('cancel_export');
    } catch (e) {
      console.error('キャンセルに失敗しました', e);
    }
  };

  const rateControlLabel: Record<string, string> = {
    cbr: '固定ビットレート。安定したファイルサイズ。',
    vbr: '可変ビットレート。YouTubeに推奨。',
    crf: '品質固定。エンコーダが自動でビット配分。'
  };

  return (
    <div style={{
      position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
      background: 'rgba(0,0,0,0.8)', zIndex: 200,
      display: 'flex', alignItems: 'center', justifyContent: 'center'
    }}>
      <div style={{
        background: '#0f172a', borderRadius: '12px',
        border: '1px solid #334155', width: '460px',
        display: 'flex', flexDirection: 'column',
        maxHeight: '90vh', overflow: 'hidden'
      }}>
        {/* ヘッダー */}
        <div style={{ padding: '16px 20px', borderBottom: '1px solid #1e293b' }}>
          <h2 style={{ margin: 0, color: '#e2e8f0', fontSize: '1rem', fontWeight: 600 }}>動画のエクスポート</h2>
        </div>

        <div style={{ overflowY: 'auto', padding: '20px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
          {!isExporting ? (
            <>
              {/* プリセット */}
              <div style={rowStyle}>
                <label style={labelStyle}>プリセット</label>
                <select value={preset} onChange={e => applyPreset(e.target.value)} style={{ ...selectStyle, fontWeight: preset !== 'custom' ? 600 : 400 }}>
                  {EXPORT_PRESETS.filter(p => p.id !== 'custom').map(p => (
                    <option key={p.id} value={p.id}>{p.label}</option>
                  ))}
                  {customPresets.length > 0 && (
                    <optgroup label="保存したプリセット">
                      {customPresets.map(p => (
                        <option key={p.id} value={p.id}>★ {p.label}</option>
                      ))}
                    </optgroup>
                  )}
                  <option value="custom">カスタム</option>
                </select>
                <button
                  onClick={handleSavePreset}
                  title="現在の設定をプリセットとして保存"
                  style={{ flexShrink: 0, padding: '7px 10px', background: '#1e293b', color: '#cbd5e1', border: '1px solid #334155', borderRadius: '4px', cursor: 'pointer', fontSize: '0.78rem' }}
                >
                  保存
                </button>
                {isCustomPresetSelected && (
                  <button
                    onClick={handleDeletePreset}
                    title="選択中のカスタムプリセットを削除"
                    style={{ flexShrink: 0, padding: '7px 10px', background: '#1e293b', color: '#f87171', border: '1px solid #334155', borderRadius: '4px', cursor: 'pointer', fontSize: '0.78rem' }}
                  >
                    削除
                  </button>
                )}
              </div>

              {/* プリセット名の入力（保存ボタン押下時のみ表示） */}
              {namingPreset && (
                <div style={rowStyle}>
                  <label style={labelStyle}>プリセット名</label>
                  <input
                    autoFocus
                    value={presetNameInput}
                    onChange={e => setPresetNameInput(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') confirmSavePreset();
                      else if (e.key === 'Escape') setNamingPreset(false);
                    }}
                    placeholder="例: 配信用 1080p"
                    style={{ flex: 1, padding: '7px 8px', background: '#1e293b', color: 'white', border: '1px solid #3b82f6', borderRadius: '4px', outline: 'none', fontSize: '0.85rem' }}
                  />
                  <button
                    onClick={confirmSavePreset}
                    disabled={!presetNameInput.trim()}
                    style={{ flexShrink: 0, padding: '7px 12px', background: '#3b82f6', color: '#fff', border: 'none', borderRadius: '4px', cursor: presetNameInput.trim() ? 'pointer' : 'default', opacity: presetNameInput.trim() ? 1 : 0.5, fontSize: '0.78rem', fontWeight: 600 }}
                  >
                    保存
                  </button>
                  <button
                    onClick={() => setNamingPreset(false)}
                    style={{ flexShrink: 0, padding: '7px 12px', background: '#1e293b', color: '#94a3b8', border: '1px solid #334155', borderRadius: '4px', cursor: 'pointer', fontSize: '0.78rem' }}
                  >
                    キャンセル
                  </button>
                </div>
              )}

              <div style={{ borderTop: '1px solid #1e293b' }} />

              {/* 書き出し範囲 */}
              <div style={rowStyle}>
                <label style={labelStyle}>書き出し範囲</label>
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  <div style={{ display: 'flex', gap: '4px' }}>
                    <button
                      onClick={() => exportRange.useRange && setRangeMode('range')}
                      disabled={!exportRange.useRange}
                      title={exportRange.useRange ? undefined : 'タイムラインで In/Out 点が設定されていません'}
                      style={{
                        flex: 1,
                        padding: '5px 0',
                        background: rangeMode === 'range' ? '#3b82f6' : '#1e293b',
                        border: `1px solid ${rangeMode === 'range' ? '#3b82f6' : '#334155'}`,
                        borderRadius: '4px',
                        color: rangeMode === 'range' ? '#fff' : '#94a3b8',
                        fontSize: '0.78rem',
                        fontWeight: 600,
                        cursor: exportRange.useRange ? 'pointer' : 'not-allowed',
                        opacity: exportRange.useRange ? 1 : 0.4
                      }}
                    >
                      設定した範囲
                    </button>
                    <button
                      onClick={() => setRangeMode('full')}
                      style={{
                        flex: 1,
                        padding: '5px 0',
                        background: rangeMode === 'full' ? '#3b82f6' : '#1e293b',
                        border: `1px solid ${rangeMode === 'full' ? '#3b82f6' : '#334155'}`,
                        borderRadius: '4px',
                        color: rangeMode === 'full' ? '#fff' : '#94a3b8',
                        fontSize: '0.78rem',
                        fontWeight: 600,
                        cursor: 'pointer'
                      }}
                    >
                      全範囲
                    </button>
                  </div>
                  <span style={{ fontSize: '0.72rem', color: '#64748b' }}>
                    {rangeMode === 'range' && exportRange.useRange
                      ? `${formatTimecode(exportRange.start)} 〜 ${formatTimecode(exportRange.end)}（${(exportRange.end - exportRange.start).toFixed(1)}秒）`
                      : `動画全体（${formatTimecode(duration)}）`}
                  </span>
                </div>
              </div>

              <div style={{ borderTop: '1px solid #1e293b' }} />

              {/* 映像設定 */}
              <div style={rowStyle}>
                <label style={labelStyle}>解像度</label>
                <select value={video.resolution} onChange={e => updateVideo('resolution', e.target.value)} style={selectStyle}>
                  <option value="3840x2160">4K (3840×2160)</option>
                  <option value="1920x1080">フルHD (1920×1080)</option>
                  <option value="1280x720">HD (1280×720)</option>
                </select>
              </div>

              <div style={rowStyle}>
                <label style={labelStyle}>フレームレート</label>
                <select value={video.fps} onChange={e => updateVideo('fps', e.target.value)} style={selectStyle}>
                  <option value="60">60 fps</option>
                  <option value="30">30 fps</option>
                  <option value="29.97">29.97 fps</option>
                  <option value="24">24 fps</option>
                </select>
              </div>

              <div style={rowStyle}>
                <label style={labelStyle}>エンコーダ</label>
                <select value={video.encoder} onChange={e => updateVideo('encoder', e.target.value)} style={selectStyle}>
                  <option value="auto">自動（推奨）</option>
                  <option value="nvenc">H.264 NVENC (NVIDIA GPU)</option>
                  <option value="hevc_nvenc">H.265 NVENC (NVIDIA GPU)</option>
                  <option value="qsv">H.264 QSV (Intel GPU)</option>
                  <option value="amf">H.264 AMF (AMD GPU)</option>
                  <option value="libx264">H.264 x264 (CPU)</option>
                  <option value="libx265">H.265 x265 (CPU)</option>
                </select>
              </div>

              {/* レート制御 */}
              <div style={rowStyle}>
                <label style={labelStyle}>レート制御</label>
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  <div style={{ display: 'flex', gap: '4px' }}>
                    {(['cbr', 'vbr', 'crf'] as const).map(rc => (
                      <button
                        key={rc}
                        onClick={() => updateVideo('rateControl', rc)}
                        style={{
                          flex: 1,
                          padding: '5px 0',
                          background: video.rateControl === rc ? '#3b82f6' : '#1e293b',
                          border: `1px solid ${video.rateControl === rc ? '#3b82f6' : '#334155'}`,
                          borderRadius: '4px',
                          color: video.rateControl === rc ? '#fff' : '#94a3b8',
                          fontSize: '0.78rem',
                          fontWeight: 600,
                          cursor: 'pointer',
                          letterSpacing: '0.05em'
                        }}
                      >
                        {rc.toUpperCase()}
                      </button>
                    ))}
                  </div>
                  <span style={{ fontSize: '0.72rem', color: '#64748b' }}>
                    {rateControlLabel[video.rateControl]}
                  </span>
                </div>
              </div>

              {/* ビットレート / CRF */}
              {video.rateControl === 'crf' ? (
                <div style={rowStyle}>
                  <label style={labelStyle}>品質 (CRF値)</label>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                      <span style={{ fontSize: '0.72rem', color: '#64748b' }}>高画質 (0)</span>
                      <span style={{ fontSize: '0.8rem', color: '#38bdf8', fontWeight: 700 }}>{video.crfValue}</span>
                      <span style={{ fontSize: '0.72rem', color: '#64748b' }}>低画質 (51)</span>
                    </div>
                    <input
                      type="range" min="0" max="51" step="1" value={video.crfValue}
                      onChange={e => updateVideo('crfValue', Number(e.target.value))}
                      style={{ width: '100%', accentColor: '#3b82f6', cursor: 'pointer' }}
                    />
                  </div>
                </div>
              ) : (
                <>
                  <div style={rowStyle}>
                    <label style={labelStyle}>{video.rateControl === 'vbr' ? '目標ビットレート' : 'ビットレート'}</label>
                    <select value={video.bitrate} onChange={e => updateVideo('bitrate', e.target.value)} style={selectStyle}>
                      <option value="4M">4 Mbps</option>
                      <option value="8M">8 Mbps</option>
                      <option value="12M">12 Mbps</option>
                      <option value="16M">16 Mbps</option>
                      <option value="20M">20 Mbps</option>
                      <option value="30M">30 Mbps</option>
                      <option value="40M">40 Mbps</option>
                    </select>
                  </div>
                  {video.rateControl === 'vbr' && (
                    <div style={rowStyle}>
                      <label style={labelStyle}>最大ビットレート</label>
                      <select value={video.maxrate} onChange={e => updateVideo('maxrate', e.target.value)} style={selectStyle}>
                        <option value="6M">6 Mbps</option>
                        <option value="12M">12 Mbps</option>
                        <option value="18M">18 Mbps</option>
                        <option value="24M">24 Mbps</option>
                        <option value="30M">30 Mbps</option>
                        <option value="45M">45 Mbps</option>
                        <option value="60M">60 Mbps</option>
                      </select>
                    </div>
                  )}
                </>
              )}

              <div style={{ borderTop: '1px solid #1e293b' }} />

              {/* 音声設定 */}
              <div style={rowStyle}>
                <label style={labelStyle}>音声品質</label>
                <select value={audioQuality} onChange={e => setAudioQuality(e.target.value as any)} style={selectStyle}>
                  <option value="standard">標準 (AAC 256kbps)</option>
                  <option value="high">高音質 (AAC 384kbps)</option>
                  <option value="lossless">最高音質・可逆圧縮 (ALAC)</option>
                </select>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <input type="checkbox" id="loudnorm" checked={loudnorm}
                  onChange={e => setLoudnorm(e.target.checked)}
                  style={{ width: '16px', height: '16px', cursor: 'pointer' }} />
                <label htmlFor="loudnorm" style={{ color: '#cbd5e1', cursor: 'pointer', fontSize: '0.85rem' }}>
                  ラウドネス調整 (-14 LUFSに自動適応)
                </label>
              </div>

              {/* ボタン */}
              <div style={{ display: 'flex', gap: '10px', paddingTop: '4px' }}>
                <button onClick={onClose} className="btn-secondary" style={{ flex: 1 }}>キャンセル</button>
                <button onClick={handleExport} className="btn-primary" style={{ flex: 1, background: '#10b981' }}>
                  書き出し開始
                </button>
              </div>
            </>
          ) : errorMsg ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', padding: '12px 0', width: '100%' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#f87171', fontWeight: 'bold', fontSize: '0.95rem' }}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="8" x2="12" y2="12" />
                  <line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
                書き出しに失敗しました
              </div>
              <div style={{
                background: '#1e1416',
                border: '1px solid #7f1d1d',
                borderRadius: '6px',
                padding: '10px 12px',
                color: '#fca5a5',
                fontFamily: 'monospace',
                fontSize: '0.72rem',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
                maxHeight: '260px',
                overflowY: 'auto',
                userSelect: 'text',
              }}>{errorMsg}</div>
              <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
                <button
                  onClick={() => { navigator.clipboard?.writeText(errorMsg).catch(() => {}); }}
                  className="btn-secondary"
                >エラー内容をコピー</button>
                <button
                  onClick={() => { setErrorMsg(''); setIsExporting(false); setStatusMsg(''); setProgress(0); }}
                  className="btn-primary"
                >設定に戻る</button>
              </div>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '15px', alignItems: 'center', padding: '20px 0', width: '100%' }}>
              {statusMsg.startsWith('FFmpeg: ') ? (
                <div style={{
                  color: '#64748b',
                  fontFamily: 'monospace',
                  fontSize: '0.7rem',
                  maxWidth: '100%',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap'
                }} title={statusMsg}>{statusMsg}</div>
              ) : (
                <div style={{ color: '#60a5fa', fontWeight: 'bold' }}>{statusMsg}</div>
              )}
              <div style={{ width: '100%', height: '20px', background: '#1e293b', borderRadius: '10px', overflow: 'hidden' }}>
                <div style={{ width: `${progress}%`, height: '100%', background: 'linear-gradient(90deg, #3b82f6, #8b5cf6)', transition: 'width 0.5s' }} />
              </div>
              <div style={{ fontSize: '0.8rem', color: '#94a3b8' }}>
                エンコード中はPCの動作が重くなる場合があります。
              </div>
              {progress < 100 && (
                <button
                  onClick={handleCancelExport}
                  disabled={isCancelling}
                  className="btn-secondary"
                  style={{ marginTop: '10px', opacity: isCancelling ? 0.5 : 1, cursor: isCancelling ? 'default' : 'pointer' }}
                >
                  {isCancelling ? 'キャンセル中...' : '書き出しをキャンセル'}
                </button>
              )}
              {progress === 100 && (
                <div style={{ display: 'flex', gap: '10px', marginTop: '10px' }}>
                  <button onClick={handleOpenFolder} className="btn-secondary" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
                    </svg>
                    出力フォルダを開く
                  </button>
                  <button onClick={onClose} className="btn-primary">閉じる</button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
