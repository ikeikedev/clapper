import { useState, useEffect, useRef, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open, save, ask, message } from '@tauri-apps/plugin-dialog';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { documentDir, join } from '@tauri-apps/api/path';
import { Timeline, getTrackColor, formatTimecode, TRACK_COLORS } from './Timeline';
import { VideoPreview } from './VideoPreview';
import { MixerModal } from './MixerModal';
import { ExportModal } from './ExportModal';
import { PreferencesModal, DEFAULT_PREFERENCES, type AppPreferences } from './PreferencesModal';
import { ShortcutHelpModal } from './ShortcutHelpModal';
import { audioEngine, DEFAULT_MASTER_STATE, DEFAULT_TRACK_AUDIO_STATE, DEFAULT_EQ } from './AudioEngine';
import type { TrackData, CutPoint, MasterAudioState, ExportRange, ColorState } from './types';
import { DEFAULT_COLOR_STATE } from './types';
import './App.css';

// 書き出し範囲の初期値（フェード4項目を含む完全な形）。
// リセット時にこれを使うことで、フェード設定が undefined に欠落するのを防ぐ。
const DEFAULT_EXPORT_RANGE: ExportRange = {
  start: 0,
  end: 100,
  useRange: false,
  fadeIn: false,
  fadeInDuration: 0.5,
  fadeOut: false,
  fadeOutDuration: 0.5
};

// プロジェクトファイルのスキーマバージョン。フォーマットを変更したら上げる。
// 読込時にこの値と比較し、より新しいファイルを開こうとしたら警告する。
const PROJECT_SCHEMA_VERSION = 1;

// トランジション種別の選択肢。カードの select・トランスポートバーの select・
// カットのコンテキストメニューで共有し、項目や文言の分岐を一箇所に集約する。
// （※トランジションバッジのツールチップは「暗転/明転」という別文言のため対象外）
const TRANSITION_OPTIONS: { value: CutPoint['transition']; label: string }[] = [
  { value: 'cut', label: 'Cut (カット即時切替)' },
  { value: 'crossfade', label: 'Fade (クロスフェード)' },
  { value: 'dip_to_black', label: 'Black (黒フェード)' },
  { value: 'dip_to_white', label: 'White (白フェード)' },
];

function App() {
  let appWindow: any = null;
  try {
    appWindow = getCurrentWindow();
  } catch (e) {
    console.warn("Tauri appWindow is not available.");
  }
  const [isMaximized, setIsMaximized] = useState(false);

  const handleMinimize = () => {
    if (appWindow) appWindow.minimize();
  };
  const handleMaximize = async () => {
    if (appWindow) {
      if (await appWindow.isMaximized()) {
        appWindow.unmaximize();
      } else {
        appWindow.maximize();
      }
    }
  };
  const handleClose = () => {
    if (appWindow) appWindow.close();
  };

  useEffect(() => {
    const handleResize = async () => {
      if (!appWindow) return;
      try {
        setIsMaximized(await appWindow.isMaximized());
      } catch (e) {
        console.error("Failed to check maximized state", e);
      }
    };
    window.addEventListener('resize', handleResize);
    handleResize();
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const [tracks, setTracks] = useState<TrackData[]>([]);
  const [cuts, setCuts] = useState<CutPoint[]>([]);
  const [currentTime, setCurrentTime] = useState(0);

  const setCleanCuts =(newCuts: CutPoint[], nextTracks?: TrackData[]) => {
    const currentTracks = nextTracks || tracks;
    const defaultCameraId = currentTracks.find(t => t.isRef && !t.isAudioOnly)?.id || currentTracks.find(t => !t.isAudioOnly)?.id || currentTracks[0]?.id;
    const sorted = [...newCuts].sort((a, b) => a.timeSeconds - b.timeSeconds);
    let lastCameraId = defaultCameraId;
    const cleaned = sorted.filter(cut => {
      if (cut.cameraId === lastCameraId) {
        return false;
      }
      lastCameraId = cut.cameraId;
      return true;
    });
    setCuts(cleaned);
    return cleaned;
  };
  const [isPlaying, _setIsPlaying] = useState(false);
  const isPlayingRef = useRef(false);
  const setIsPlaying = (playing: boolean | ((prev: boolean) => boolean)) => {
    _setIsPlaying(prev => {
      const next = typeof playing === 'function' ? playing(prev) : playing;
      isPlayingRef.current = next;
      return next;
    });
  };

  const isSeekingRef = useRef(false);
  const seekTimeoutRef = useRef<number | null>(null);
  const isVideoSyncingRef = useRef(false);

  const handleTimeChange = (time: number | ((prev: number) => number)) => {
    isSeekingRef.current = true;
    if (seekTimeoutRef.current) {
      window.clearTimeout(seekTimeoutRef.current);
    }
    seekTimeoutRef.current = window.setTimeout(() => {
      isSeekingRef.current = false;
    }, 400);

    // Web Audio チャンク再生エンジンへシークを通知（再生中なら即座に組み直し、停止中なら次回再生位置を更新）
    if (typeof time === 'function') {
      setCurrentTime(prev => {
        const targetTime = time(prev);
        audioEngine.playback.seek(targetTime);
        return targetTime;
      });
    } else {
      setCurrentTime(time);
      audioEngine.playback.seek(time);
    }
  };

  const cutsContainerRef = useRef<HTMLDivElement>(null);

  const [pixelsPerSecond, setPixelsPerSecond] = useState(50);
  const [isProcessing, setIsProcessing] = useState(false);
  const [statusText, setStatusText] = useState('メディアを追加してください');
  const [masterVolume, setMasterVolume] = useState(1.0);
  const prevVolumeRef = useRef<number>(1.0);
  const handleToggleMute = () => {
    if (masterVolume > 0) {
      prevVolumeRef.current = masterVolume;
      setMasterVolume(0);
    } else {
      setMasterVolume(prevVolumeRef.current || 1.0);
    }
  };
  const [activeTab, setActiveTab] = useState<'cuts' | 'mixer' | 'color'>('cuts');
  const [expandedColorTrackId, setExpandedColorTrackId] = useState<string | null>(null);
  const [isExportModalOpen, setIsExportModalOpen] = useState(false);
  const [isDraggingOffset, setIsDraggingOffset] = useState(false);
  const [masterState, setMasterState] = useState<MasterAudioState>(DEFAULT_MASTER_STATE);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    cutId?: string;
    cutTime?: number;
  } | null>(null);
  const [exportRange, setExportRange] = useState<ExportRange>({ ...DEFAULT_EXPORT_RANGE });
  const [previewOverrideCameraId, setPreviewOverrideCameraId] = useState<string | null>(null);
  
  const [currentProjectPath, setCurrentProjectPath] = useState<string | null>(null);
  // 前回プロジェクトを保存したフォルダ（保存ダイアログの初期位置に使う）
  const lastSaveDirRef = useRef<string | null>(localStorage.getItem('mcse_last_save_dir'));
  const [recentProjects, setRecentProjects] = useState<string[]>([]);
  const [preferences, setPreferences] = useState<AppPreferences>(DEFAULT_PREFERENCES);
  const [isPreferencesOpen, setIsPreferencesOpen] = useState(false);
  const [isShortcutHelpOpen, setIsShortcutHelpOpen] = useState(false);
  const [activeMenu, setActiveMenu] = useState<string | null>(null);
  const [refMediaConfirm, setRefMediaConfirm] = useState<{ path: string, providedName?: string } | null>(null);

  useEffect(() => {
    const saved = localStorage.getItem('mcse_preferences');
    if (saved) {
      try {
        setPreferences({ ...DEFAULT_PREFERENCES, ...JSON.parse(saved) });
      } catch (e) {
        console.error("Failed to load preferences", e);
      }
    }
    const savedRecent = localStorage.getItem('mcse_recent_projects');
    if (savedRecent) {
      try {
        const arr = JSON.parse(savedRecent);
        if (Array.isArray(arr)) setRecentProjects(arr.filter((p: any) => typeof p === 'string'));
      } catch (e) {
        console.error("Failed to load recent projects", e);
      }
    }
  }, []);

  // 最近使ったプロジェクト履歴に追加（先頭へ・重複除去・最大8件）。localStorage に永続化。
  const MAX_RECENT_PROJECTS = 8;
  const addRecentProject = (path: string) => {
    setRecentProjects(prev => {
      const next = [path, ...prev.filter(p => p !== path)].slice(0, MAX_RECENT_PROJECTS);
      localStorage.setItem('mcse_recent_projects', JSON.stringify(next));
      return next;
    });
  };

  // 開けなかった履歴項目を一覧から除去する
  const removeRecentProject = (path: string) => {
    setRecentProjects(prev => {
      const next = prev.filter(p => p !== path);
      localStorage.setItem('mcse_recent_projects', JSON.stringify(next));
      return next;
    });
  };

  const duration = tracks.length > 0 ? Math.max(...tracks.map(t => (t.peaks.length / 50) + Math.abs(t.offsetSeconds))) : 100;

  const handleUpdateAudioState = (id: string, newState: any) => {
    setTracks(prev => prev.map(t => t.id === id ? { ...t, audioState: newState } : t));
  };

  const handleUpdateColorState = (trackId: string, updates: Partial<ColorState>) => {
    setTracks(prev => prev.map(t => {
      if (t.id === trackId) {
        return {
          ...t,
          colorState: { ...(t.colorState || DEFAULT_COLOR_STATE), ...updates }
        };
      }
      return t;
    }));
  };

  const handleColorChangeComplete = () => {
    pushHistory(tracks, cuts);
  };

  const handleUpdateMasterState = (newState: MasterAudioState) => {
    setMasterState(newState);
    audioEngine.updateMasterState(newState);
  };

  useEffect(() => {
    const closeMenus = () => {
      setContextMenu(null);
      setActiveMenu(null);
    };
    window.addEventListener('click', closeMenus);
    return () => window.removeEventListener('click', closeMenus);
  }, []);

  useEffect(() => {
    if (!exportRange.useRange) {
      setExportRange(prev => ({ ...prev, end: duration }));
    }
  }, [duration, exportRange.useRange]);

  const activeCutForScroll = [...cuts].reverse().find(c => c.timeSeconds <= currentTime);
  const activeCutIdForScroll = activeCutForScroll?.id;

  useEffect(() => {
    if (activeCutIdForScroll && cutsContainerRef.current) {
      const activeEl = document.getElementById(`cut-card-${activeCutIdForScroll}`);
      if (activeEl) {
        cutsContainerRef.current.scrollTo({
          top: activeEl.offsetTop,
          behavior: 'smooth'
        });
      }
    }
  }, [activeCutIdForScroll]);

  // ─────────────────────────────────────
  // 履歴（Undo/Redo）管理
  // ─────────────────────────────────────
  const historyRef = useRef<{ 
    tracks: TrackData[], 
    cuts: CutPoint[],
    exportRange: ExportRange
  }[]>([{
    tracks: [],
    cuts: [],
    exportRange: { ...DEFAULT_EXPORT_RANGE }
  }]);
  const historyIndexRef = useRef<number>(0);

  // 未保存の変更があるか（保存/読込/新規でクリア、編集で true）。
  // ウィンドウを閉じる際やプロジェクト破棄前の警告に使う（ref は閉じる確認の
  // クロージャから最新値を読むため。state はウィンドウタイトルの再描画用）。
  const isDirtyRef = useRef<boolean>(false);
  const [isDirty, setIsDirtyState] = useState(false);

  // 保存/読込/新規で「未保存なし」に戻す（ref と state を同時に更新）。
  // ※編集時の dirty=true は pushHistory が ref を立て、下の useEffect が state に反映する。
  //   pushHistory は setTracks の updater 内から呼ばれることがあり、render 中の
  //   setState を避けるため pushHistory 自身では state を触らない設計にしている。
  const markClean = () => {
    isDirtyRef.current = false;
    setIsDirtyState(false);
  };

  // 編集（tracks/cuts/exportRange の変化）後に ref の dirty 状態を state へ反映する。
  useEffect(() => {
    if (isDirtyRef.current) setIsDirtyState(true);
  }, [tracks, cuts, exportRange]);

  // ウィンドウを閉じる操作（カスタムタイトルバーの×・Alt+F4 とも）を横取りし、
  // 未保存変更があれば確認する。preventDefault でクローズを中断できる。
  useEffect(() => {
    if (!appWindow) return;
    let unlisten: (() => void) | undefined;
    appWindow.onCloseRequested((event: any) => {
      if (!isDirtyRef.current) return;
      // window.confirm はパッケージ版 WebView2 で正しく動作しない（ダイアログが表示されず
      // ブロックし続ける）ため、ここでは必ず一旦キャンセルし、ネイティブダイアログ(ask)
      // で確認した後に明示的に destroy() でウィンドウを閉じる。
      event.preventDefault();
      ask('保存されていない変更があります。アプリを終了しますか？', { title: '確認', kind: 'warning' })
        .then((proceed: boolean) => {
          if (proceed) {
            isDirtyRef.current = false;
            appWindow.destroy().catch(() => {});
          }
        })
        .catch(() => {});
    }).then((fn: () => void) => { unlisten = fn; }).catch(() => {});
    return () => { if (unlisten) unlisten(); };
  }, []);

  // ウィンドウタイトルに編集中ファイル名と未保存マーク(*)を反映する（タスクバー/Alt+Tab 用）
  useEffect(() => {
    if (!appWindow) return;
    const baseName = currentProjectPath
      ? currentProjectPath.split(/[\\/]/).pop()
      : (tracks.length > 0 ? '無題' : null);
    const title = baseName ? `${baseName}${isDirty ? ' *' : ''} — Clapper` : 'Clapper';
    appWindow.setTitle(title).catch(() => {});
  }, [isDirty, currentProjectPath, tracks.length]);

  const pushHistory = (
    newTracks: TrackData[],
    newCuts: CutPoint[],
    newExportRange?: ExportRange
  ) => {
    const currentHistory = historyRef.current.slice(0, historyIndexRef.current + 1);
    const clonedTracks = JSON.parse(JSON.stringify(newTracks));
    const clonedCuts = JSON.parse(JSON.stringify(newCuts));
    const targetRange = newExportRange || exportRange;
    const clonedRange = JSON.parse(JSON.stringify(targetRange));
    
    currentHistory.push({ 
      tracks: clonedTracks, 
      cuts: clonedCuts, 
      exportRange: clonedRange 
    });
    if (currentHistory.length > 50) {
      currentHistory.shift();
    }
    historyRef.current = currentHistory;
    historyIndexRef.current = currentHistory.length - 1;
    isDirtyRef.current = true;
  };

  const handleExportRangeChange = (
    updater: ExportRange | ((prev: ExportRange) => ExportRange),
    commit: boolean = true
  ) => {
    setExportRange(prev => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      // ドラッグ中は commit=false で履歴に積まず、確定時(mouseup)に一度だけ積む
      if (commit) pushHistory(tracks, cuts, next);
      return next;
    });
  };

  const handleUndo = () => {
    if (historyIndexRef.current > 0) {
      historyIndexRef.current--;
      const { tracks: prevTracks, cuts: prevCuts, exportRange: prevRange } = historyRef.current[historyIndexRef.current];
      setTracks(JSON.parse(JSON.stringify(prevTracks)));
      setCuts(JSON.parse(JSON.stringify(prevCuts)));
      if (prevRange) setExportRange(JSON.parse(JSON.stringify(prevRange)));
      isDirtyRef.current = true;
      setStatusText('元に戻しました (Undo)');
    } else {
      setStatusText('これ以上元に戻せません');
    }
  };

  const handleRedo = () => {
    if (historyIndexRef.current < historyRef.current.length - 1) {
      historyIndexRef.current++;
      const { tracks: nextTracks, cuts: nextCuts, exportRange: nextRange } = historyRef.current[historyIndexRef.current];
      setTracks(JSON.parse(JSON.stringify(nextTracks)));
      setCuts(JSON.parse(JSON.stringify(nextCuts)));
      if (nextRange) setExportRange(JSON.parse(JSON.stringify(nextRange)));
      isDirtyRef.current = true;
      setStatusText('やり直しました (Redo)');
    } else {
      setStatusText('これ以上やり直せません');
    }
  };
  
  const handlersRef = useRef<any>({});
  const wasPlayingBeforeArrowRef = useRef<boolean>(false);
  const arrowHeldRef = useRef<boolean>(false);
  const arrowHoldStartRef = useRef<number>(0);

  useEffect(() => {
    handlersRef.current = {
      handleUndo,
      handleRedo,
      handlePlayPause,
      handleAngleChangeRequested,
      handleForceAddCut,
      handleManualCut,
      handlePrevCut,
      handleNextCut,
      handleSetExportStartAtCurrentTime,
      handleSetExportEndAtCurrentTime,
      handleSaveProject,
      handleOpenProject,
      handleNewProject,
      openExport: () => {
        // File メニューの Export と同じ可否条件を満たす場合のみ開く
        if (tracks.length > 0 && !(exportRange.useRange && exportRange.end <= exportRange.start)) {
          setIsExportModalOpen(true);
        }
      },
      setCurrentTime: handleTimeChange,
      setPlaying: handlePlayingChangeFromTimeline,
      isPlaying,
      currentTime,
      duration,
      tracks,
      preferences
    };
  });


  useEffect(() => {
    const releaseFocusOnMouseUp = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const textTags = ['INPUT', 'TEXTAREA', 'SELECT'];
      if (textTags.includes(target.tagName)) return;
      requestAnimationFrame(() => {
        const active = document.activeElement as HTMLElement | null;
        if (active && !textTags.includes(active.tagName)) {
          active.blur();
        }
      });
    };
    document.addEventListener('mouseup', releaseFocusOnMouseUp);
    return () => document.removeEventListener('mouseup', releaseFocusOnMouseUp);
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const activeEl = document.activeElement;
      const isTextInput =
        (activeEl?.tagName === 'INPUT' && (activeEl as HTMLInputElement).type !== 'range') ||
        activeEl?.tagName === 'TEXTAREA' ||
        activeEl?.tagName === 'SELECT' ||
        activeEl?.getAttribute('contenteditable') === 'true';
      if (isTextInput) {
        return;
      }
      
      const {
        handleUndo: latestUndo,
        handleRedo: latestRedo,
        handlePlayPause: latestPlayPause,
        handleAngleChangeRequested: latestAngleChangeRequested,
        handleForceAddCut: latestForceAddCut,
        handleManualCut: latestManualCut,
        handlePrevCut: latestPrevCut,
        handleNextCut: latestNextCut,
        handleSetExportStartAtCurrentTime: latestSetExportStart,
        handleSetExportEndAtCurrentTime: latestSetExportEnd,
        handleSaveProject: latestSaveProject,
        handleOpenProject: latestOpenProject,
        handleNewProject: latestNewProject,
        openExport: latestOpenExport,
        setCurrentTime: latestSetTime,
        setPlaying: latestSetPlaying,
        isPlaying: latestIsPlaying,
        currentTime: latestCurrentTime,
        duration: latestDuration,
        tracks: latestTracks,
        preferences: latestPreferences
      } = handlersRef.current;

      // Ctrl / Cmd 系ショートカット
      if (e.ctrlKey || e.metaKey) {
        const key = e.key.toLowerCase();
        if (key === 'z') {
          e.preventDefault();
          if (e.shiftKey) latestRedo(); else latestUndo();
        } else if (key === 'y') {
          e.preventDefault();
          latestRedo();
        } else if (key === 's') {
          e.preventDefault();
          latestSaveProject(e.shiftKey); // Ctrl+Shift+S = 名前を付けて保存
        } else if (key === 'o') {
          e.preventDefault();
          latestOpenProject();
        } else if (key === 'n') {
          e.preventDefault();
          latestNewProject();
        } else if (key === 'e') {
          e.preventDefault();
          latestOpenExport();
        }
        return;
      }

      // ?: ショートカット一覧の表示/非表示（Shift + / 等）
      if (e.key === '?') {
        e.preventDefault();
        setIsShortcutHelpOpen(prev => !prev);
        return;
      }

      // Space: Play/Pause
      if (e.code === 'Space') {
        e.preventDefault();
        latestPlayPause();
      }

      // Key C: Cut
      if (e.code === 'KeyC') {
        e.preventDefault();
        latestManualCut();
      }

      // ArrowLeft / ArrowRight: frame step (Shift = 5s seek)
      // 再生中の最初の押下で即座に停止し、keyup で再開する
      // OS/webview 環境によって e.repeat が信頼できないため、独自フラグで「押下中」を判定する
      if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
        e.preventDefault();
        if (!arrowHeldRef.current) {
          arrowHeldRef.current = true;
          arrowHoldStartRef.current = performance.now();
          if (latestIsPlaying) {
            // AudioContext を即時サスペンドして音を止める（React 再レンダリング待ちを避ける）
            audioEngine.ctx?.suspend();
            latestSetPlaying(false);
            wasPlayingBeforeArrowRef.current = true;
          }
        }
        const frameDuration = 1 / (latestPreferences?.projectFps ?? 60);
        // 0.6秒以上の長押しでステップ幅を5フレーム分に加速
        const holdElapsed = performance.now() - arrowHoldStartRef.current;
        const accelMultiplier = holdElapsed > 600 ? 5 : 1;
        const step = e.shiftKey ? 5.0 : frameDuration * accelMultiplier;
        if (e.code === 'ArrowLeft') {
          const next = Math.max(0, (latestCurrentTime ?? 0) - step);
          latestSetTime(next);
        } else {
          const next = Math.min(latestDuration ?? 100, (latestCurrentTime ?? 0) + step);
          latestSetTime(next);
        }
      }

      // ArrowUp / ArrowDown: prev/next cut
      if (e.code === 'ArrowUp') {
        e.preventDefault();
        latestPrevCut();
      } else if (e.code === 'ArrowDown') {
        e.preventDefault();
        latestNextCut();
      }

      // [ / ]: Export range start/end
      if (e.code === 'BracketLeft') {
        e.preventDefault();
        latestSetExportStart();
      } else if (e.code === 'BracketRight') {
        e.preventDefault();
        latestSetExportEnd();
      }

      // 1 - 9 keys: Angle selection (number row or numpad)
      const isDigit = e.code.startsWith('Digit') || e.code.startsWith('Numpad');
      if (isDigit) {
        const match = e.code.match(/\d/);
        if (match) {
          const num = parseInt(match[0], 10);
          const videoTracks = latestTracks.filter((t: any) => !t.isAudioOnly);
          if (num >= 1 && num <= videoTracks.length) {
            e.preventDefault();
            const targetTrack = videoTracks[num - 1];
            if (e.altKey) {
              latestForceAddCut(targetTrack.id);
            } else {
              latestAngleChangeRequested(targetTrack.id);
            }
          }
        }
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
        arrowHeldRef.current = false;
        if (wasPlayingBeforeArrowRef.current) {
          wasPlayingBeforeArrowRef.current = false;
          // setPlaying(true) の内部で audioEngine.resume() が呼ばれるが、
          // suspend() 後に確実に再開するためここでも呼ぶ
          audioEngine.ctx?.resume().then(() => {
            handlersRef.current.setPlaying?.(true);
          });
        }
      }
    };

    // Alt+Tab 等でフォーカスが外れ keyup が発火しない場合に備え、保持状態をリセットする
    const handleBlur = () => {
      if (arrowHeldRef.current) {
        arrowHeldRef.current = false;
        if (wasPlayingBeforeArrowRef.current) {
          wasPlayingBeforeArrowRef.current = false;
          audioEngine.ctx?.resume().then(() => {
            handlersRef.current.setPlaying?.(true);
          });
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown, { capture: true });
    window.addEventListener('keyup', handleKeyUp, { capture: true });
    window.addEventListener('blur', handleBlur);
    return () => {
      window.removeEventListener('keydown', handleKeyDown, { capture: true });
      window.removeEventListener('keyup', handleKeyUp, { capture: true });
      window.removeEventListener('blur', handleBlur);
    };
  }, []);

  // 再生タイマー
  const lastTimeRef = useRef<number>(0);
  const exportRangeRef = useRef(exportRange);
  useEffect(() => { exportRangeRef.current = exportRange; }, [exportRange]);

  const currentTimeRef = useRef(currentTime);
  useEffect(() => { currentTimeRef.current = currentTime; }, [currentTime]);

  // 【Web Audio 再生】isPlaying に追従してチャンク再生エンジンを駆動する。
  // ここで唯一 play/pause を集中管理するので、setIsPlaying(false) するどの経路でも確実に止まる。
  useEffect(() => {
    if (isPlaying) {
      audioEngine.playback.play(currentTimeRef.current);
    } else {
      audioEngine.playback.pause();
    }
  }, [isPlaying]);

  const shouldAutoStopRef = useRef(false);
  useEffect(() => {
    if (isPlaying) {
      const range = exportRangeRef.current;
      shouldAutoStopRef.current = range.useRange && currentTimeRef.current < range.end;
    } else {
      shouldAutoStopRef.current = false;
    }
  }, [isPlaying]);

  useEffect(() => {
    let animationFrame: number;
    lastTimeRef.current = performance.now();
    
    const loop = () => {
      if (isPlayingRef.current) {
        // 再生位置は Web Audio チャンク再生エンジンのクロック（サンプル精度）を正とする
        const head = audioEngine.playback.getPlayheadTime();
        setCurrentTime(() => {
          const range = exportRangeRef.current;
          if (shouldAutoStopRef.current && head >= range.end) {
            setIsPlaying(false);
            return range.end;
          }
          if (head >= duration) {
            setIsPlaying(false);
            return duration;
          }
          return head;
        });
      }
      animationFrame = requestAnimationFrame(loop);
    };
    lastTimeRef.current = performance.now();
    animationFrame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(animationFrame);
  }, [isPlaying, duration]);

  const [isGridView, setIsGridView] = useState(false);

  // ─────────────────────────────────────
  // プロキシ進捗リスナー設定
  // ─────────────────────────────────────
  useEffect(() => {
    const unlisten = listen<number>('proxy-progress', (event) => {
      setStatusText(`プロキシ動画生成中... ${event.payload}%`);
    });
    return () => {
      unlisten.then(f => f());
    };
  }, []);

  const preferencesRef = useRef<AppPreferences>(preferences);
  useEffect(() => { preferencesRef.current = preferences; }, [preferences]);

  // ─────────────────────────────────────
  // トラック追加
  // ─────────────────────────────────────
  const processSelectedFile = async (selected: string, isRef: boolean, providedName?: string, forceAudioOnly?: boolean) => {
    const isAudioFile = /\.(wav|mp3|m4a|aac|flac|ogg)$/i.test(selected);
    
    // リファレンス動画ファイルで、かつまだ「音声のみか映像ありか」が未決定の場合、確認モーダルを開く
    if (isRef && !isAudioFile && forceAudioOnly === undefined) {
      setIsProcessing(false); // ファイルダイアログ等で processing になっていたら一時解除
      setRefMediaConfirm({ path: selected, providedName });
      return;
    }

    const isAudioOnly = forceAudioOnly !== undefined ? forceAudioOnly : isAudioFile;
    if (!isRef && isAudioOnly) {
      setStatusText('追加アングルには音声ファイルは追加できません');
      return;
    }

    setIsProcessing(true);
    await audioEngine.resume();
    
    const id = `cam_${Date.now()}`;
    const refTrack = tracksRef.current.find(t => t.isRef);
    const refHasVideo = refTrack && !refTrack.isAudioOnly;
    const existingCamCount = tracksRef.current.filter(t => !t.isRef).length;
    const camIndex = (refHasVideo ? 1 : 0) + existingCamCount + 1;
    const name = providedName || (isRef ? 'Ref Media' : `Camera ${camIndex}`);
    
    // 1. 音声抽出
    setStatusText('音声を解析中...');
    const extractedPath = await invoke<string>('extract_audio', {
      videoPath: selected
    });
    
    // 2. 波形生成
    const peaks = await invoke<number[]>('generate_waveform', {
      wavPath: extractedPath,
      pointsPerSecond: 50
    });

    // 3. プロキシ動画の生成 (非同期実行 - 音声のみでない場合のみ)
    if (!isAudioOnly) {
      invoke<string>('generate_proxy_video', {
        videoPath: selected,
        threads: preferencesRef.current.ffmpegThreads,
        crf: preferencesRef.current.proxyCrf,
        resolution: preferencesRef.current.proxyResolution
      }).then((proxyPath) => {
        setTracks(prev => prev.map(t => t.id === id ? { ...t, proxyPath } : t));
        setStatusText(`プロキシ動画生成完了: ${name}`);
      }).catch(e => {
        console.error("Proxy generation failed:", e);
        setStatusText(`プロキシ動画の生成に失敗しました: ${name}`);
      });
    }

    const newTrack = {
      id,
      name,
      path: selected,
      wavPath: extractedPath,
      proxyPath: undefined,
      peaks,
      offsetSeconds: 0,
      isRef,
      audioState: { ...DEFAULT_TRACK_AUDIO_STATE, isMuted: !isRef },
      isAudioOnly,
      isLocked: false,
      colorState: DEFAULT_COLOR_STATE
    };
    
    setTracks(prev => {
      const nonRefCount = prev.filter(t => !t.isRef).length;
      const color = isRef ? TRACK_COLORS[0] : TRACK_COLORS[1 + (nonRefCount % (TRACK_COLORS.length - 1))];
      const next = [...prev, { ...newTrack, color }];
      pushHistory(next, cuts);
      return next;
    });
    setStatusText(`追加完了: ${name}`);

    // 【フェーズ3a】再生エンジン用にフル品質PCMを抽出して登録する（DAW式チャンク再生のデータ供給）。
    // この時点ではまだ再生経路は切り替えていない（挙動は従来どおりメディア要素再生）。
    invoke<{ path: string; durationSeconds: number }>('extract_playback_audio', { videoPath: selected })
      .then(pb => audioEngine.playback.loadTrack(id, pb.path, 0, isRef))
      .then(() => console.log(`[playback] loaded PCM for ${name}`))
      .catch(e => console.error('再生用音声の抽出/読み込みに失敗:', e));

    // REF メディア読み込み時は、波形全体がちょうどウィンドウに収まるズーム倍率に自動設定する
    if (isRef) {
      const refDurationSec = peaks.length / 50; // 波形は 50pts/秒
      if (refDurationSec > 0) {
        requestAnimationFrame(() => {
          const scrollEl = document.querySelector('.timeline-right-scroll') as HTMLElement | null;
          const availWidth = (scrollEl?.clientWidth ?? (window.innerWidth - 180)) - 24; // 左右に少し余白
          const fitPps = Math.max(0.1, Math.min(200, availWidth / refDurationSec));
          setPixelsPerSecond(fitPps);
        });
      }
    }
  };

  const handleAddTrack = async (isRef: boolean) => {
    // トラック追加操作を始めたら再生を一時停止する
    setIsPlaying(false);

    try {
      const extensions = isRef 
        ? ['mp4', 'mov', 'avi', 'mkv', 'wav', 'mp3'] 
        : ['mp4', 'mov', 'avi', 'mkv'];
      const selected = await open({
        multiple: false,
        filters: [{ name: 'Media', extensions }]
      });
      if (typeof selected !== 'string') return;
      await processSelectedFile(selected, isRef);
    } catch (err) {
      console.error(err);
      setStatusText(`エラー: ${err}`);
    } finally {
      setIsProcessing(false);
    }
  };

  // ─────────────────────────────────────
  // ドラッグ＆ドロップ対応
  // ─────────────────────────────────────
  const tracksRef = useRef<TrackData[]>(tracks);
  useEffect(() => { tracksRef.current = tracks; }, [tracks]);

  const [isDragHovering, setIsDragHovering] = useState(false);
  const dropTargetRef = useRef<'ref' | 'cam' | 'ref-locked' | null>(null);
  const [dropTargetUi, setDropTargetUi] = useState<'ref' | 'cam' | 'ref-locked' | null>(null);

  useEffect(() => {
    const unlistenDrop = listen<{ paths: string[] }>('tauri://drag-drop', async (event) => {
      setIsDragHovering(false);
      setDropTargetUi(null);
      const paths = event.payload.paths;
      if (!paths || paths.length === 0) return;
      
      setIsPlaying(false);
      
      const target = dropTargetRef.current;
      if (!target) return;
      
      let hasRef = tracksRef.current.some(t => t.isRef);
      let refTrack = tracksRef.current.find(t => t.isRef);
      let refHasVideo = refTrack && !refTrack.isAudioOnly;
      let camCount = tracksRef.current.filter(t => !t.isRef).length;

      try {
        for (const path of paths) {
          if (path.match(/\.(mp4|mov|avi|mkv|wav|mp3)$/i)) {
            let isRef = false;
            if (target === 'ref') {
              isRef = true;
            } else if (target === 'cam') {
              isRef = false;
            } else {
              isRef = !hasRef;
            }

            const isAudio = /\.(wav|mp3|m4a|aac|flac|ogg)$/i.test(path);
            if (!isRef && isAudio) {
              setStatusText('追加アングルには音声ファイルは追加できません');
              continue;
            }

            let name = 'Ref Media';
            if (isRef) {
              hasRef = true;
              refHasVideo = !isAudio;
            } else {
              camCount++;
              const camIndex = (refHasVideo ? 1 : 0) + camCount;
              name = `Camera ${camIndex}`;
            }

            await processSelectedFile(path, isRef, name);
          }
        }
      } finally {
        setIsProcessing(false);
        dropTargetRef.current = null;
      }
    });

    const unlistenEnter = listen('tauri://drag-enter', () => setIsDragHovering(true));
    const unlistenOver = listen<{ position: { x: number, y: number } }>('tauri://drag-over', (event) => {
      const x = event.payload.position.x / window.devicePixelRatio;
      const width = window.innerWidth;
      const hasRef = tracksRef.current.some(t => t.isRef);

      if (!hasRef) {
        if (dropTargetRef.current !== 'ref') {
          setDropTargetUi('ref');
          dropTargetRef.current = 'ref';
        }
      } else {
        if (x < width / 2) {
          if (dropTargetRef.current !== 'ref-locked') {
            setDropTargetUi('ref-locked');
            dropTargetRef.current = null;
          }
        } else {
          if (dropTargetRef.current !== 'cam') {
            setDropTargetUi('cam');
            dropTargetRef.current = 'cam';
          }
        }
      }
    });

    const unlistenLeave = listen('tauri://drag-leave', () => { 
      setIsDragHovering(false);
      setDropTargetUi(null);
      dropTargetRef.current = null;
    });
    
    return () => {
      unlistenDrop.then(f => f());
      unlistenEnter.then(f => f());
      unlistenOver.then(f => f());
      unlistenLeave.then(f => f());
    };
  }, []);

  // ─────────────────────────────────────
  // トラック削除
  // ─────────────────────────────────────
  const handleDeleteTrack = async (trackId: string) => {
    const target = tracks.find(t => t.id === trackId);
    const nextTracks = tracks.filter(t => t.id !== trackId);
    // REF（基準）トラックを削除すると同期の基準が失われるため、他トラックが残る場合は確認する
    if (target?.isRef && nextTracks.length > 0) {
      const ok = await ask(
        'REF（基準）トラックを削除すると、他のアングルの自動同期の基準が失われます。本当に削除しますか？',
        { title: 'REFトラックの削除', kind: 'warning' }
      );
      if (!ok) return;
    }
    setIsPlaying(false);
    // 再生エンジンから登録解除（残すと再生時にスケジュールされ続ける）
    audioEngine.playback.removeTrack(trackId);
    audioEngine.removeTrack(trackId);
    const nextCuts = cuts.filter(c => c.cameraId !== trackId);
    setTracks(nextTracks);
    const cleaned = setCleanCuts(nextCuts, nextTracks);
    pushHistory(nextTracks, cleaned);
    setStatusText('トラックを削除しました');
  };

  // ─────────────────────────────────────
  // トラックの並べ替え（ドラッグ）— カメラ(非REF)トラックを対象に順序を入れ替える。
  // 1〜9 キーの割り当て順やタイムライン/ミキサーの表示順に反映される。
  // カットは cameraId 参照なので順序変更の影響を受けない。
  // ─────────────────────────────────────
  const handleTrackReorder = (draggedId: string, targetId: string) => {
    if (draggedId === targetId) return;
    const from = tracks.findIndex(t => t.id === draggedId);
    const toOrig = tracks.findIndex(t => t.id === targetId);
    if (from === -1 || toOrig === -1) return;
    const next = [...tracks];
    const [moved] = next.splice(from, 1);
    const to = next.findIndex(t => t.id === targetId);
    // 下に移動する場合はドロップ先の後ろに、上に移動する場合は前に挿入
    next.splice(toOrig > from ? to + 1 : to, 0, moved);
    setTracks(next);
    pushHistory(next, cuts);
    setStatusText('トラックの順序を変更しました');
  };

  // ─────────────────────────────────────
  // 手動同期（ユーザーが任意でボタンを押す）
  // ─────────────────────────────────────
  const handleSyncTrack = async (trackId: string) => {
    const refTrack = tracks.find(t => t.isRef);
    const targetTrack = tracks.find(t => t.id === trackId);
    if (!refTrack || !targetTrack || refTrack.id === targetTrack.id) return;
    if (targetTrack.isLocked) return;

    // 自動同期実行時に再生を一時停止する
    setIsPlaying(false);

    try {
      setIsProcessing(true);
      setStatusText(`${targetTrack.name} の自動同期を計算中...`);
      
      const offset = await invoke<number>('calculate_sync_offset', {
        refPath: refTrack.wavPath,
        targetPath: targetTrack.wavPath
      });
      
      const roundedOffset = Math.round(offset * 1000) / 1000;
      
      setTracks(prev => {
        const next = prev.map(t =>
          t.id === trackId ? { ...t, offsetSeconds: roundedOffset, lastAutoSyncedOffset: roundedOffset } : t
        );
        pushHistory(next, cuts);
        return next;
      });
      // 再生エンジンへ通知（= offset + 音声ディレイ）
      audioEngine.playback.setTrackOffset(trackId, roundedOffset + (targetTrack.audioOffsetSeconds || 0));
      setStatusText(`${targetTrack.name} の同期完了 (ズレ: ${roundedOffset > 0 ? '+' : ''}${roundedOffset.toFixed(3)}s)`);
    } catch (err) {
      console.error(err);
      setStatusText(`同期エラー: ${err}`);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleSyncAllTracks = async () => {
    if (isProcessing) return;
    const refTrack = tracks.find(t => t.isRef);
    if (!refTrack) {
      setStatusText("基準（REF）トラックが見つかりません。");
      return;
    }
    
    const targetTracks = tracks.filter(t => !t.isRef && !t.isLocked);
    if (targetTracks.length === 0) {
      setStatusText("同期可能なトラックがありません。");
      return;
    }
    
    setIsPlaying(false);
    setIsProcessing(true);
    setStatusText("一括自動同期を開始します...");
    
    let successCount = 0;
    let failCount = 0;
    
    try {
      const syncPromises = targetTracks.map(async (track) => {
        try {
          const offset = await invoke<number>('calculate_sync_offset', {
            refPath: refTrack.wavPath,
            targetPath: track.wavPath
          });
          const roundedOffset = Math.round(offset * 1000) / 1000;
          return { id: track.id, offset: roundedOffset, success: true };
        } catch (err) {
          console.error(`Sync failed for ${track.name}:`, err);
          return { id: track.id, offset: 0, success: false, error: err };
        }
      });
      
      const results = await Promise.all(syncPromises);
      
      setTracks(prev => {
        const next = prev.map(t => {
          const res = results.find(r => r.id === t.id);
          if (res && res.success) {
            successCount++;
            // 再生エンジンへ通知（= offset + 音声ディレイ）
            audioEngine.playback.setTrackOffset(t.id, res.offset + (t.audioOffsetSeconds || 0));
            return { ...t, offsetSeconds: res.offset, lastAutoSyncedOffset: res.offset };
          } else if (res) {
            failCount++;
          }
          return t;
        });
        pushHistory(next, cuts);
        return next;
      });

      setStatusText(`一括同期完了: 成功 ${successCount}件, 失敗 ${failCount}件`);
    } catch (err) {
      console.error(err);
      setStatusText(`一括同期エラー: ${err}`);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleTrackOffsetChange = (trackId: string, newOffset: number, commit: boolean) => {
    const targetTrack = tracks.find(t => t.id === trackId);
    if (targetTrack?.isLocked) return;
    const roundedOffset = Math.round(newOffset * 1000) / 1000;
    setIsDraggingOffset(!commit);
    // 再生エンジンへトラックのコンテンツオフセットを通知（= offset + 音声ディレイ）
    audioEngine.playback.setTrackOffset(trackId, roundedOffset + (targetTrack?.audioOffsetSeconds || 0));
    setTracks(prev => {
      const next = prev.map(t => {
        if (t.id === trackId) {
          const currentRounded = Math.round(t.offsetSeconds * 1000) / 1000;
          if (currentRounded === roundedOffset) {
            return t;
          }
          return { ...t, offsetSeconds: roundedOffset, lastAutoSyncedOffset: undefined };
        }
        return t;
      });
      if (commit) {
        const hasChanged = prev.some(t => t.id === trackId && (Math.round(t.offsetSeconds * 1000) / 1000) !== roundedOffset);
        if (hasChanged) {
          pushHistory(next, cuts);
          setStatusText(`オフセットを調整しました: ${roundedOffset > 0 ? '+' : ''}${roundedOffset.toFixed(3)}s`);
        }
      }
      return next;
    });
  };

  const handleToggleLockTrack = (trackId: string) => {
    setTracks(prev => {
      const next = prev.map(t => 
        t.id === trackId ? { ...t, isLocked: !t.isLocked } : t
      );
      pushHistory(next, cuts);
      const target = next.find(t => t.id === trackId);
      if (target) {
        setStatusText(`${target.name} を${target.isLocked ? 'ロックしました' : 'ロック解除しました'}`);
      }
      return next;
    });
  };

  const handleTrackNameChange = (trackId: string, newName: string) => {
    setTracks(prev => prev.map(t => t.id === trackId ? { ...t, name: newName } : t));
  };

  const handleOffsetBadgeMouseDown = (e: React.MouseEvent, track: TrackData) => {
    if (track.isLocked) return;
    e.preventDefault();
    e.stopPropagation();
    
    const startX = e.clientX;
    const startOffset = track.offsetSeconds;
    let currentOffset = startOffset;
    
    const originalCursor = document.body.style.cursor;
    document.body.style.cursor = 'ew-resize';
    
    const handleMouseMove = (moveEvent: MouseEvent) => {
      const deltaX = moveEvent.clientX - startX;
      const fps = preferencesRef.current.projectFps ?? 60;
      // 8px = 1フレーム
      const frames = Math.round(deltaX / 8);
      currentOffset = startOffset + (frames / fps);
      handleTrackOffsetChange(track.id, currentOffset, false);
    };
    
    const handleMouseUp = () => {
      document.body.style.cursor = originalCursor;
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      handleTrackOffsetChange(track.id, currentOffset, true);
    };
    
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  };

  const handleOffsetBadgeDoubleClick = (e: React.MouseEvent, track: TrackData) => {
    if (track.isLocked) return;
    e.preventDefault();
    e.stopPropagation();
    handleTrackOffsetChange(track.id, 0, true);
  };

  const handleTrackAudioOffsetChange = (trackId: string, newAudioOffset: number, commit: boolean) => {
    const targetTrack = tracks.find(t => t.id === trackId);
    if (targetTrack?.isLocked) return;
    const roundedOffset = Math.round(newAudioOffset * 1000) / 1000;
    setIsDraggingOffset(!commit);
    // 再生エンジンへトラックのコンテンツオフセットを通知（= offset + 音声ディレイ）
    audioEngine.playback.setTrackOffset(trackId, (targetTrack?.offsetSeconds || 0) + roundedOffset);
    setTracks(prev => {
      const next = prev.map(t => {
        if (t.id === trackId) {
          const currentAudioOffset = t.audioOffsetSeconds || 0;
          if (currentAudioOffset === roundedOffset) {
            return t;
          }
          return { ...t, audioOffsetSeconds: roundedOffset };
        }
        return t;
      });
      if (commit) {
        const hasChanged = prev.some(t => t.id === trackId && (t.audioOffsetSeconds || 0) !== roundedOffset);
        if (hasChanged) {
          pushHistory(next, cuts);
          setStatusText(`音声オフセットを調整しました: ${roundedOffset > 0 ? '+' : ''}${roundedOffset.toFixed(3)}s`);
        }
      }
      return next;
    });
  };

  const handleDefaultDurationDragMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    const startX = e.clientX;
    const initialVal = preferences.defaultTransitionDuration || 0.5;
    let newVal = initialVal;

    const originalCursor = document.body.style.cursor;
    document.body.style.cursor = 'ew-resize';

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const deltaX = moveEvent.clientX - startX;
      const deltaSeconds = deltaX * 0.02; // 感度調整
      const rawVal = initialVal + deltaSeconds;
      newVal = Math.max(0.1, Math.min(5.0, Math.round(rawVal * 10) / 10));
      
      const updated = { ...preferences, defaultTransitionDuration: newVal };
      setPreferences(updated);
    };

    const handleMouseUp = () => {
      document.body.style.cursor = originalCursor;
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      
      // localStorageに最新の状態を即座にコミット
      const finalPrefs = { ...preferencesRef.current, defaultTransitionDuration: newVal };
      localStorage.setItem('mcse_preferences', JSON.stringify(finalPrefs));
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  };

  const handlePrevCut = () => {
    const sorted = [...cuts].sort((a, b) => a.timeSeconds - b.timeSeconds);
    const prev = [...sorted].reverse().find(c => c.timeSeconds < currentTime - 0.05);
    handleTimeChange(prev ? prev.timeSeconds : 0);
  };

  const handleNextCut = () => {
    const sorted = [...cuts].sort((a, b) => a.timeSeconds - b.timeSeconds);
    const next = sorted.find(c => c.timeSeconds > currentTime + 0.05);
    if (next) handleTimeChange(next.timeSeconds);
  };

  const handleManualCut = () => {
    // 現在の activeCameraId を推測 (デフォルトはマスター、もしくは直前のカット)
    let activeCameraId = cuts.findLast(c => c.timeSeconds <= currentTime)?.cameraId || tracks.find(t => t.isRef && !t.isAudioOnly)?.id || tracks.find(t => !t.isAudioOnly)?.id || tracks[0]?.id;
    
    if (!activeCameraId) return;

    let targetCameraId = previewOverrideCameraId !== null ? previewOverrideCameraId : activeCameraId;
    const videoTracks = tracks.filter(t => !t.isAudioOnly);
    // トラックが2つの場合、かつオーバーライドがない場合、もう一方のカメラに自動でトグルする
    if (previewOverrideCameraId === null && videoTracks.length === 2) {
      const otherTrack = videoTracks.find(t => t.id !== activeCameraId);
      if (otherTrack) targetCameraId = otherTrack.id;
    }
    
    handleCutRequested(targetCameraId);
    setPreviewOverrideCameraId(null); // カット作成後は追従に戻す
  };

  const handleSetExportStartAtCurrentTime = () => {
    handleExportRangeChange(prev => ({
      ...prev,
      start: currentTime,
      useRange: true
    }));
    setStatusText(`書き出し始点を設定しました: ${formatTimecode(currentTime)}`);
  };

  const handleSetExportEndAtCurrentTime = () => {
    handleExportRangeChange(prev => ({
      ...prev,
      end: currentTime,
      useRange: true
    }));
    setStatusText(`書き出し終点を設定しました: ${formatTimecode(currentTime)}`);
  };

  const handleTransportRangeLimitDragMouseDown = (e: React.MouseEvent, type: 'start' | 'end') => {
    e.preventDefault();
    e.stopPropagation();

    const startX = e.clientX;
    const initialVal = type === 'start' ? (exportRange?.start || 0) : (exportRange?.end || duration);
    let newVal = initialVal;

    const originalCursor = document.body.style.cursor;
    document.body.style.cursor = 'ew-resize';

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const deltaX = moveEvent.clientX - startX;
      const deltaSeconds = deltaX / pixelsPerSecond;
      const fps = preferences.projectFps ?? 60;
      const frameDuration = 1 / fps;
      const rawVal = Math.round((initialVal + deltaSeconds) / frameDuration) * frameDuration;

      if (type === 'start') {
        const minVal = 0;
        const maxVal = (exportRange?.end || duration) - 0.1;
        newVal = Math.max(minVal, Math.min(rawVal, maxVal));
        handleExportRangeChange(prev => ({ ...prev, start: newVal }), false);
      } else {
        const minVal = (exportRange?.start || 0) + 0.1;
        const maxVal = duration;
        newVal = Math.max(minVal, Math.min(rawVal, maxVal));
        handleExportRangeChange(prev => ({ ...prev, end: newVal }), false);
      }
    };

    const handleMouseUp = () => {
      document.body.style.cursor = originalCursor;
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      // ドラッグ確定時に最終値を一度だけ履歴へ積む
      handleExportRangeChange(prev => prev, true);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  };

  const handleTransportFadeDurationDragMouseDown = (e: React.MouseEvent, type: 'fadeIn' | 'fadeOut') => {
    e.preventDefault();
    e.stopPropagation();

    const startX = e.clientX;
    const isCurrentlyActive = type === 'fadeIn' ? !!exportRange.fadeIn : !!exportRange.fadeOut;
    const initialVal = type === 'fadeIn' 
      ? (exportRange?.fadeInDuration ?? 0.5) 
      : (exportRange?.fadeOutDuration ?? 2.0); // デフォルト 2.0秒
    let newVal = initialVal;
    let hasMoved = false;

    const originalCursor = document.body.style.cursor;
    document.body.style.cursor = 'ew-resize';

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const deltaX = moveEvent.clientX - startX;
      if (Math.abs(deltaX) > 3) {
        hasMoved = true;
      }
      const deltaSeconds = deltaX * 0.02;
      const rawVal = initialVal + deltaSeconds;

      newVal = Math.max(0.1, Math.min(5.0, Math.round(rawVal * 10) / 10));

      if (type === 'fadeIn') {
        handleExportRangeChange(prev => ({
          ...prev,
          fadeIn: true,
          fadeInDuration: newVal
        }), false);
      } else {
        handleExportRangeChange(prev => ({
          ...prev,
          fadeOut: true,
          fadeOutDuration: newVal
        }), false);
      }
    };

    const handleMouseUp = (upEvent: MouseEvent) => {
      document.body.style.cursor = originalCursor;
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);

      const deltaX = upEvent.clientX - startX;
      if (Math.abs(deltaX) <= 3 && !hasMoved) {
        // 単なるクリックとみなしてトグル切り替え（履歴へ確定）
        if (type === 'fadeIn') {
          handleExportRangeChange(prev => ({
            ...prev,
            fadeIn: !isCurrentlyActive,
            fadeInDuration: prev.fadeInDuration ?? 0.5
          }), true);
        } else {
          handleExportRangeChange(prev => ({
            ...prev,
            fadeOut: !isCurrentlyActive,
            fadeOutDuration: prev.fadeOutDuration ?? 2.0
          }), true);
        }
      } else {
        // ドラッグ確定時に最終値を一度だけ履歴へ積む
        handleExportRangeChange(prev => prev, true);
      }
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  };

  const handleCutRequested = (cameraId: string, timeSeconds?: number) => {
    const targetTime = timeSeconds !== undefined ? timeSeconds : currentTime;
    let nextCuts = [...cuts];
    const existingCutIndex = cuts.findIndex(c => Math.abs(c.timeSeconds - targetTime) < 0.1);
    if (existingCutIndex >= 0) {
      nextCuts[existingCutIndex].cameraId = cameraId;
    } else {
      const defType = preferences.defaultTransitionType || 'cut';
      const defDuration = defType !== 'cut' ? (preferences.defaultTransitionDuration || 0.5) : 0;
      nextCuts.push({
        id: `cut_${Date.now()}`,
        timeSeconds: targetTime,
        cameraId,
        transition: defType,
        transitionDuration: defDuration
      });
    }
    const cleaned = setCleanCuts(nextCuts);
    pushHistory(tracks, cleaned);
  };

  const handleAngleChangeRequested = (cameraId: string) => {
    // Preview Mode: Only override preview camera, don't modify cuts!
    // Currently on-air camera ID (calculated from cuts)
    let onAirCameraId = tracks.find(t => t.isRef && !t.isAudioOnly)?.id || tracks.find(t => !t.isAudioOnly)?.id || tracks[0]?.id;
    const sortedCuts = [...cuts].sort((a, b) => a.timeSeconds - b.timeSeconds);
    for (const cut of sortedCuts) {
      if (currentTime >= cut.timeSeconds) {
        onAirCameraId = cut.cameraId;
      } else {
        break;
      }
    }

    if (cameraId === onAirCameraId) {
      setPreviewOverrideCameraId(null);
    } else {
      setPreviewOverrideCameraId(cameraId);
    }
  };

  const handleForceAddCut = (cameraId: string) => {
    setPreviewOverrideCameraId(null);
    handleCutRequested(cameraId);
  };

  const handleCutDelete = (id: string) => {
    const nextCuts = cuts.filter(c => c.id !== id);
    const cleaned = setCleanCuts(nextCuts);
    pushHistory(tracks, cleaned);
  };

  const handleCutUpdate = (id: string, updates: Partial<CutPoint>) => {
    const nextCuts = cuts.map(c => c.id === id ? { ...c, ...updates } : c);
    const cleaned = setCleanCuts(nextCuts);
    pushHistory(tracks, cleaned);
  };

  const handleCutTimeDragMouseDown = (e: React.MouseEvent, cut: CutPoint) => {
    e.preventDefault();
    e.stopPropagation();
    
    const startX = e.clientX;
    const startTime = cut.timeSeconds;
    let lastTime = startTime;
    
    const originalCursor = document.body.style.cursor;
    document.body.style.cursor = 'ew-resize';
    
    const handleMouseMove = (moveEvent: MouseEvent) => {
      const deltaX = moveEvent.clientX - startX;
      const fps = preferencesRef.current.projectFps ?? 60;
      const frames = Math.round(deltaX / 5);
      const deltaSeconds = frames / fps;
      
      const sortedCuts = [...cuts].sort((a, b) => a.timeSeconds - b.timeSeconds);
      const idx = sortedCuts.findIndex(c => c.id === cut.id);
      const minVal = idx > 0 ? sortedCuts[idx - 1].timeSeconds + 0.05 : 0;
      const maxVal = idx < sortedCuts.length - 1 ? sortedCuts[idx + 1].timeSeconds - 0.05 : duration;
      
      const newTime = Math.max(minVal, Math.min(maxVal, startTime + deltaSeconds));
      lastTime = newTime;
      
      setCuts(prevCuts => prevCuts.map(c => c.id === cut.id ? { ...c, timeSeconds: newTime } : c));
    };
    
    const handleMouseUp = () => {
      document.body.style.cursor = originalCursor;
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      
      const nextCuts = cuts.map(c => c.id === cut.id ? { ...c, timeSeconds: lastTime } : c);
      const cleaned = setCleanCuts(nextCuts);
      pushHistory(tracks, cleaned);
    };
    
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  };

  const handleCutDurationDragMouseDown = (e: React.MouseEvent, cut: CutPoint) => {
    e.preventDefault();
    e.stopPropagation();
    
    const startX = e.clientX;
    const startDuration = cut.transitionDuration;
    let currentDuration = startDuration;
    
    const originalCursor = document.body.style.cursor;
    document.body.style.cursor = 'ew-resize';
    
    const handleMouseMove = (moveEvent: MouseEvent) => {
      const deltaX = moveEvent.clientX - startX;
      const deltaSeconds = deltaX * 0.01;
      const rawVal = startDuration + deltaSeconds;
      currentDuration = Math.max(0.1, Math.min(5.0, Math.round(rawVal * 10) / 10));
      
      setCuts(prevCuts => prevCuts.map(c => c.id === cut.id ? { ...c, transitionDuration: currentDuration } : c));
    };
    
    const handleMouseUp = () => {
      document.body.style.cursor = originalCursor;
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      
      const nextCuts = cuts.map(c => c.id === cut.id ? { ...c, transitionDuration: currentDuration } : c);
      const cleaned = setCleanCuts(nextCuts);
      pushHistory(tracks, cleaned);
    };
    
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  };

  // ─────────────────────────────────────
  // プロジェクト管理 (新規・保存・開く)
  // ─────────────────────────────────────
  const handleNewProject = async () => {
    if (isDirtyRef.current) {
      const proceed = await ask("保存されていない変更があります。破棄して新規プロジェクトを作成しますか？", { title: '確認', kind: 'warning' });
      if (!proceed) return;
    }
    setIsPlaying(false);
    audioEngine.playback.reset();
    setTracks([]);
    setCuts([]);
    setCurrentTime(0);
    setCurrentProjectPath(null);
    historyRef.current = [{ tracks: [], cuts: [], exportRange: { ...DEFAULT_EXPORT_RANGE } }];
    historyIndexRef.current = 0;
    setExportRange({ ...DEFAULT_EXPORT_RANGE });
    setPreviewOverrideCameraId(null);
    markClean();
    setStatusText('新規プロジェクトを作成しました');
  };

  const handleSaveProject = async (saveAs = false) => {
    setIsPlaying(false);
    try {
      let path = currentProjectPath;
      if (!path || saveAs) {
        // 保存ダイアログの初期フォルダを明示する。指定しないと Windows は
        // 「直前に使ったフォルダ（=メディアを開いたフォルダ）」を流用してしまうため、
        // 既存プロジェクトのフォルダ → 前回保存フォルダ → ドキュメント の優先で決める。
        let dir: string | null = currentProjectPath
          ? currentProjectPath.replace(/[\\/][^\\/]*$/, '')
          : lastSaveDirRef.current;
        if (!dir) {
          try { dir = await documentDir(); } catch { dir = null; }
        }
        let defaultPath = 'project.json';
        if (dir) {
          try { defaultPath = await join(dir, 'project.json'); } catch { defaultPath = 'project.json'; }
        }
        const selected = await save({
          filters: [{ name: 'Project', extensions: ['json'] }],
          defaultPath
        });
        if (!selected) return;
        path = selected;
        // 選んだフォルダを次回の初期フォルダとして記憶する
        const chosenDir = path.replace(/[\\/][^\\/]*$/, '');
        if (chosenDir && chosenDir !== path) {
          lastSaveDirRef.current = chosenDir;
          localStorage.setItem('mcse_last_save_dir', chosenDir);
        }
      }
      
      const projectData = {
        version: PROJECT_SCHEMA_VERSION,
        tracks,
        cuts,
        exportRange
      };

      await invoke('save_project_file', {
        path,
        content: JSON.stringify(projectData, null, 2)
      });

      setCurrentProjectPath(path);
      markClean();
      addRecentProject(path);
      setStatusText(`プロジェクトを保存しました: ${path.split(/[\\/]/).pop()}`);
    } catch (err) {
      console.error(err);
      setStatusText(`保存エラー: ${err}`);
    }
  };

  // 指定パスのプロジェクトを実際に読み込むコア処理（ダイアログ・未保存確認は呼び出し側が行う）。
  // 'loaded'=読込成功 / 'declined'=ユーザーがバージョン警告で中止 / 'error'=読込失敗
  const loadProjectFromPath = async (path: string): Promise<'loaded' | 'declined' | 'error'> => {
    setIsPlaying(false);
    try {
      const content = await invoke<string>('load_project_file', { path });
      const projectData = JSON.parse(content);

      if (!projectData.tracks || !projectData.cuts) {
        throw new Error("無効なプロジェクトファイルです。");
      }

      // スキーマバージョン確認（より新しいファイルは互換性が保証できない）
      const fileVersion = typeof projectData.version === 'number' ? projectData.version : 1;
      if (fileVersion > PROJECT_SCHEMA_VERSION) {
        const proceed = await ask(
          `このプロジェクトはより新しいバージョン (v${fileVersion}) で保存されています。\nお使いのアプリ (v${PROJECT_SCHEMA_VERSION}) では正しく読み込めない可能性があります。続行しますか？`,
          { title: '確認', kind: 'warning' }
        );
        if (!proceed) return 'declined';
      }

      // 可搬性: 元ファイルが移動・削除されていないか確認し、欠落があれば警告する
      try {
        const sourcePaths = (projectData.tracks as any[]).map(t => t.path).filter(Boolean);
        const missing = await invoke<string[]>('check_missing_files', { paths: sourcePaths });
        if (missing.length > 0) {
          const names = missing.map(p => p.split(/[\\/]/).pop()).join('\n');
          await message(
            `次の元ファイルが見つかりませんでした。移動・削除された可能性があります。\n該当アングルの再生・書き出しはできません:\n\n${names}`,
            { title: '元ファイルが見つかりません', kind: 'warning' }
          );
        }
      } catch (e) {
        console.error('元ファイルの存在確認に失敗しました', e);
      }

      // 古いプロジェクトの audioState を補完:
      // - eqEnabled/compEnabled が無ければ false（バイパス）
      // - eq が旧形式(オブジェクト)や長さ不一致なら EQ_BANDS の数に合わせた配列へ正規化
      const normalizeEq = (eq: any): number[] =>
        DEFAULT_EQ.map((_, i) => (Array.isArray(eq) && typeof eq[i] === 'number' ? eq[i] : 0));
      const migratedTracks = (projectData.tracks as any[]).map((t: any) => ({
        ...t,
        audioState: {
          ...t.audioState,
          eq:          normalizeEq(t.audioState?.eq),
          eqEnabled:   t.audioState?.eqEnabled   ?? false,
          compEnabled: t.audioState?.compEnabled ?? false,
        }
      }));
      // 旧プロジェクトの登録を解除してから読み込む
      audioEngine.playback.reset();
      setTracks(migratedTracks);
      const cleaned = setCleanCuts(projectData.cuts, migratedTracks);

      // 再生エンジン用に各トラックの再生用PCMを抽出・登録する（チャンク再生のデータ供給）
      const anySoloedLoaded = migratedTracks.some((t: any) => t.audioState?.isSoloed);
      migratedTracks.forEach((t: any) => {
        const total = (t.offsetSeconds || 0) + (t.audioOffsetSeconds || 0);
        const audible = !t.audioState?.isMuted && (!anySoloedLoaded || t.audioState?.isSoloed);
        invoke<{ path: string }>('extract_playback_audio', { videoPath: t.path })
          .then(pb => audioEngine.playback.loadTrack(t.id, pb.path, total, audible))
          .catch(e => console.error('再生用音声の抽出/読み込みに失敗:', e));
      });
      // 古いプロジェクトファイルでフェード項目が欠けていても既定値で補完する
      const loadedRange: ExportRange = { ...DEFAULT_EXPORT_RANGE, ...(projectData.exportRange || {}) };
      setExportRange(loadedRange);

      // 履歴をリセットして読み込み時を初期状態にする
      historyRef.current = [{
        tracks: projectData.tracks,
        cuts: cleaned,
        exportRange: loadedRange
      }];
      historyIndexRef.current = 0;
      setCurrentTime(0);
      setCurrentProjectPath(path);
      setPreviewOverrideCameraId(null);
      markClean();
      addRecentProject(path);
      setStatusText(`プロジェクトを読み込みました: ${path.split(/[\\/]/).pop()}`);

      // プロキシ再生に必要なプロセスを確認
      for (const track of projectData.tracks) {
        if (!track.proxyPath && !track.isAudioOnly) {
          setStatusText(`プロキシ動画を再生成中: ${track.name}`);
          invoke<string>('generate_proxy_video', {
            videoPath: track.path,
            threads: preferencesRef.current.ffmpegThreads,
            crf: preferencesRef.current.proxyCrf,
            resolution: preferencesRef.current.proxyResolution
          }).then((proxyPath) => {
            setTracks(prev => prev.map(t => t.id === track.id ? { ...t, proxyPath } : t));
          }).catch(e => {
            console.error("Proxy generation failed on load:", e);
            setStatusText(`プロキシ動画の再生成に失敗しました: ${track.name}`);
          });
        }
      }
      return 'loaded';
    } catch (err) {
      console.error(err);
      setStatusText(`読み込みエラー: ${err}`);
      return 'error';
    }
  };

  const handleOpenProject = async () => {
    if (isDirtyRef.current) {
      const proceed = await ask("保存されていない変更があります。破棄してプロジェクトを開きますか？", { title: '確認', kind: 'warning' });
      if (!proceed) return;
    }
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: 'Project', extensions: ['json'] }]
      });
      if (typeof selected !== 'string') return;
      await loadProjectFromPath(selected);
    } catch (err) {
      console.error(err);
      setStatusText(`読み込みエラー: ${err}`);
    }
  };

  // 最近使ったプロジェクト履歴からの再オープン
  const handleOpenRecent = async (path: string) => {
    if (isDirtyRef.current) {
      const proceed = await ask("保存されていない変更があります。破棄してプロジェクトを開きますか？", { title: '確認', kind: 'warning' });
      if (!proceed) return;
    }
    const result = await loadProjectFromPath(path);
    if (result === 'error') {
      removeRecentProject(path);
      await message(
        `プロジェクトを開けませんでした。ファイルが移動・削除された可能性があります。\n履歴から削除しました:\n\n${path}`,
        { title: 'プロジェクトを開けません', kind: 'warning' }
      );
    }
  };

  const handleTimecodeMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return; // 左クリックのみ
    e.preventDefault();
    e.stopPropagation();

    const wasPlaying = isPlaying;
    if (isPlaying) {
      setIsPlaying(false);
    }

    const startX = e.clientX;
    const startTime = currentTime;
    const fps = preferences.projectFps ?? 60;
    const frameDuration = 1 / fps;

    // スクラブ感度: 5ピクセル = 1フレーム移動
    const pxPerFrame = 5;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const deltaX = moveEvent.clientX - startX;
      const framesToMove = Math.round(deltaX / pxPerFrame);
      const timeOffset = framesToMove * frameDuration;

      const newTime = Math.max(0, Math.min(startTime + timeOffset, duration));
      // 1フレーム単位にスナップ
      const roundedTime = Math.round(newTime / frameDuration) * frameDuration;
      handleTimeChange(roundedTime);
    };

    const handleMouseUp = () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';

      if (wasPlaying) {
        setIsPlaying(true);
      }
    };

    document.body.style.cursor = 'ew-resize';
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  };

  const handlePlayPause = async () => {
    // ユーザー操作時にAudioContextを再開する（ブラウザの自動再生ポリシー対応）
    await audioEngine.resume();
    setIsPlaying(!isPlaying);
  };

  const handlePlayingChangeFromTimeline = async (playing: boolean) => {
    if (playing) {
      try {
        await audioEngine.resume();
      } catch (e) {
        console.error("Failed to resume AudioEngine:", e);
      }
    }
    setIsPlaying(playing);
  };

  // 指定位置からプレビュー再生する（始点/終点/カットの▶ボタン共通）。
  // currentTime と isPlaying を同一バッチで更新し、頭出し（シーク）と再生開始の
  // 整合を同期ループ側の「協調リシンク（停止→一斉シーク→ready待ち→一斉再生）」に委ねる。
  const handlePreviewFrom = async (time: number) => {
    try {
      await audioEngine.resume();
    } catch (e) {
      console.error("Failed to resume AudioEngine:", e);
    }
    setPreviewOverrideCameraId(null);
    // 頭出し（playback.seek）→ 再生開始（isPlaying→true で playback.play(currentTime)）。
    // チャンク再生はサンプル精度で位置決めされるので、停止状態からでもクリーンに頭出しできる。
    handleTimeChange(time);
    setIsPlaying(true);
  };

  // 現在オンエア中のカメラIDを計算 (カットに基づく)
  const activeCameraId = useMemo(() => {
    let id = tracks.find(t => t.isRef && !t.isAudioOnly)?.id || tracks.find(t => !t.isAudioOnly)?.id || tracks[0]?.id;
    const sortedCuts = [...cuts].sort((a, b) => a.timeSeconds - b.timeSeconds);
    for (const cut of sortedCuts) {
      if (currentTime >= cut.timeSeconds) {
        id = cut.cameraId;
      } else {
        break;
      }
    }
    return id;
  }, [cuts, currentTime, tracks]);

  // 現在プレビュー表示中のカメラIDを決定 (プレビューモード時の手動オーバーライドに対応)
  const activePreviewCameraId = previewOverrideCameraId !== null ? previewOverrideCameraId : activeCameraId;

  // カラータブ: プレビュー中のトラックが切り替わったら、そのカードを自動展開する
  useEffect(() => {
    setExpandedColorTrackId(activePreviewCameraId);
  }, [activePreviewCameraId]);

  const hasRef = tracks.some(t => t.isRef);

  // 現在プレビュー中の映像トラックの「現在フレーム」を静止画として書き出す
  const handleExportFrame = async () => {
    const track = tracks.find(t => t.id === activePreviewCameraId);
    if (!track || track.isAudioOnly) {
      setStatusText('現在のプレビューは映像トラックではないため、画像を書き出せません');
      return;
    }
    setIsPlaying(false);
    try {
      const savePath = await save({
        filters: [{ name: 'Image', extensions: ['png', 'jpg'] }],
        defaultPath: `frame_${Math.round(currentTime)}s.png`
      });
      if (typeof savePath !== 'string') return;
      setStatusText('現在フレームを書き出し中...');
      // タイムライン時刻 → そのトラックの元動画ローカル時刻に変換
      const localTime = Math.max(0, currentTime - (track.offsetSeconds || 0));
      await invoke('export_frame', {
        sourcePath: track.path,
        timeSeconds: localTime,
        color: track.colorState ?? null,
        outputPath: savePath
      });
      setStatusText(`画像を書き出しました: ${savePath.split(/[\\/]/).pop()}`);
      try { await invoke('reveal_in_explorer', { path: savePath }); } catch (e) { console.error(e); }
    } catch (err) {
      console.error(err);
      setStatusText(`画像書き出しエラー: ${err}`);
    }
  };

  return (
    <div className="app-container">
      {isDragHovering && (
        <div 
          className="drag-drop-overlay" 
          style={{
            position: 'absolute',
            top: '32px',
            left: 0,
            right: 0,
            bottom: 0,
            display: 'flex',
            zIndex: 9999,
            background: 'rgba(5, 8, 15, 0.9)',
            backdropFilter: 'blur(8px)',
            pointerEvents: 'none'
          }}
        >
          {/* Reference Zone */}
          <div 
            style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              border: !hasRef && dropTargetUi === 'ref' 
                ? '3px dashed #10b981' 
                : '3px dashed transparent',
              background: !hasRef && dropTargetUi === 'ref' 
                ? 'rgba(16, 185, 129, 0.08)' 
                : 'transparent',
              margin: '20px',
              borderRadius: '12px',
              transition: 'all 0.2s ease',
              opacity: hasRef ? 0.35 : 1
            }}
          >
            <div style={{ marginBottom: '16px' }}>
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#10b981" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 10v4" />
                <path d="M6 6v12" />
                <path d="M9 11v2" />
                <path d="M12 4v16" />
                <path d="M15 8v8" />
                <path d="M21 9v6" />
              </svg>
            </div>
            <div style={{ fontSize: '1.2rem', fontWeight: 'bold', color: '#f8fafc', marginBottom: '8px' }}>
              Reference Media として追加
            </div>
            <div style={{ fontSize: '0.85rem', color: '#94a3b8', textAlign: 'center', maxWidth: '280px', lineHeight: 1.6 }}>
              同期の基準となる動画または音声ファイルをここにドロップします。
            </div>
          </div>

          {/* Camera Zone */}
          <div 
            style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              border: hasRef && dropTargetUi === 'cam' 
                ? '3px dashed #3b82f6' 
                : '3px dashed transparent',
              background: hasRef && dropTargetUi === 'cam' 
                ? 'rgba(59, 130, 246, 0.08)' 
                : 'transparent',
              margin: '20px',
              borderRadius: '12px',
              transition: 'all 0.2s ease',
              opacity: !hasRef ? 0.25 : 1
            }}
          >
            <div style={{ marginBottom: '16px' }}>
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="6" width="13" height="12" rx="2" />
                <path d="M15 12l7-5v10l-7-5z" />
              </svg>
            </div>
            <div style={{ fontSize: '1.2rem', fontWeight: 'bold', color: '#f8fafc', marginBottom: '8px' }}>
              同期アングルとして追加
            </div>
            <div style={{ fontSize: '0.85rem', color: '#94a3b8', textAlign: 'center', maxWidth: '280px', lineHeight: 1.6 }}>
              基準トラックと同期させるアングル映像ファイルをここにドロップします。
            </div>
          </div>
        </div>
      )}
      {/* ──────────────────────────────────
          Top Menu Bar
          ────────────────────────────────── */}
      <nav className="menu-bar" data-tauri-drag-region>
        <div className="menu-left" data-tauri-drag-region>
          <div className="menu-title-area" data-tauri-drag-region>
            <img src="/icon.png" width="18" height="18" style={{ marginRight: '6px', imageRendering: 'crisp-edges', flexShrink: 0 }} draggable={false} data-tauri-drag-region />
            <span className="menu-app-title" data-tauri-drag-region>Clapper</span>
          </div>

          <div className="menu-items">
            {/* File Menu */}
            <div className={`menu-item-container ${activeMenu === 'file' ? 'active' : ''}`}>
              <button 
                className="menu-trigger" 
                onClick={(e) => { e.stopPropagation(); setActiveMenu(activeMenu === 'file' ? null : 'file'); }}
              >
                File
              </button>
              {activeMenu === 'file' && (
                <div className="menu-dropdown">
                  <button onClick={() => { handleNewProject(); setActiveMenu(null); }}>New Project <span className="menu-shortcut">Ctrl+N</span></button>
                  <button onClick={() => { handleOpenProject(); setActiveMenu(null); }}>Open Project... <span className="menu-shortcut">Ctrl+O</span></button>
                  <div className="menu-divider" />
                  {/* 最近使ったプロジェクト */}
                  <div style={{ padding: '4px 12px 2px', fontSize: '0.65rem', color: '#64748b', whiteSpace: 'nowrap' }}>最近使ったプロジェクト</div>
                  {recentProjects.length === 0 ? (
                    <button disabled style={{ color: '#475569', fontStyle: 'italic' }}>（履歴なし）</button>
                  ) : (
                    <>
                      {recentProjects.map(p => (
                        <button
                          key={p}
                          onClick={() => { handleOpenRecent(p); setActiveMenu(null); }}
                          title={p}
                          style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
                        >
                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '210px' }}>
                            {p.split(/[\\/]/).pop()}
                          </span>
                        </button>
                      ))}
                      <button
                        onClick={() => { setRecentProjects([]); localStorage.removeItem('mcse_recent_projects'); setActiveMenu(null); }}
                        style={{ color: '#94a3b8', fontSize: '0.78rem' }}
                      >
                        履歴をクリア
                      </button>
                    </>
                  )}
                  <div className="menu-divider" />
                  <button 
                    onClick={() => { handleAddTrack(true); setActiveMenu(null); }} 
                    disabled={isProcessing || tracks.some(t => t.isRef)}
                  >
                    Import Reference Media...
                  </button>
                  <button 
                    onClick={() => { handleAddTrack(false); setActiveMenu(null); }} 
                    disabled={isProcessing || !tracks.some(t => t.isRef)}
                  >
                    Import Camera Angle...
                  </button>
                  <div className="menu-divider" />
                  <button onClick={() => { handleSaveProject(false); setActiveMenu(null); }} disabled={tracks.length === 0}>Save Project <span className="menu-shortcut">Ctrl+S</span></button>
                  <button onClick={() => { handleSaveProject(true); setActiveMenu(null); }} disabled={tracks.length === 0}>Save Project As... <span className="menu-shortcut">Ctrl+Shift+S</span></button>
                  <div className="menu-divider" />
                  <button 
                    onClick={() => { setIsExportModalOpen(true); setActiveMenu(null); }} 
                    disabled={tracks.length === 0 || (exportRange.useRange && exportRange.end <= exportRange.start)}
                    title={exportRange.useRange && exportRange.end <= exportRange.start ? "書き出し終点が始点以前のため、エクスポートできません" : undefined}
                  >
                    Export Video... <span className="menu-shortcut">Ctrl+E</span>
                  </button>
                  <button
                    onClick={() => { handleExportFrame(); setActiveMenu(null); }}
                    disabled={tracks.length === 0}
                  >
                    Export Frame (Still)...
                  </button>
                  <div className="menu-divider" />
                  <button onClick={() => { setIsPreferencesOpen(true); setActiveMenu(null); }}>Preferences...</button>
                </div>
              )}
            </div>

            {/* Edit Menu */}
            <div className={`menu-item-container ${activeMenu === 'edit' ? 'active' : ''}`}>
              <button 
                className="menu-trigger" 
                onClick={(e) => { e.stopPropagation(); setActiveMenu(activeMenu === 'edit' ? null : 'edit'); }}
              >
                Edit
              </button>
              {activeMenu === 'edit' && (
                <div className="menu-dropdown">
                  <button onClick={() => { handleUndo(); setActiveMenu(null); }}>Undo <span className="menu-shortcut">Ctrl+Z</span></button>
                  <button onClick={() => { handleRedo(); setActiveMenu(null); }}>Redo <span className="menu-shortcut">Ctrl+Y</span></button>
                </div>
              )}
            </div>

            {/* Help Menu */}
            <div className={`menu-item-container ${activeMenu === 'help' ? 'active' : ''}`}>
              <button
                className="menu-trigger"
                onClick={(e) => { e.stopPropagation(); setActiveMenu(activeMenu === 'help' ? null : 'help'); }}
              >
                Help
              </button>
              {activeMenu === 'help' && (
                <div className="menu-dropdown">
                  <button onClick={() => { setIsShortcutHelpOpen(true); setActiveMenu(null); }}>ショートカット一覧 <span className="menu-shortcut">?</span></button>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Drag Spacer */}
        <div 
          className="menu-drag-spacer" 
          data-tauri-drag-region 
          style={{ flex: 1, height: '100%', cursor: 'default' }}
          onDoubleClick={handleMaximize}
        />

        <div className="menu-right-status" data-tauri-drag-region>
          {(currentProjectPath || tracks.length > 0) && (
            <span style={{ fontSize: '0.75rem', color: '#64748b', marginRight: '16px', display: 'inline-block', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '160px', whiteSpace: 'nowrap' }} title={currentProjectPath ?? '未保存のプロジェクト'}>
              {currentProjectPath ? currentProjectPath.split(/[\\/]/).pop() : '無題'}
              {isDirty && <span style={{ color: '#f59e0b', marginLeft: '3px' }} title="未保存の変更があります">*</span>}
            </span>
          )}
          <div className="menu-status">
            <span className={`status-dot ${isProcessing ? 'processing' : 'idle'}`} />
            <span className="status-text">{statusText}</span>
          </div>
        </div>

        {/* Windows Window Controls */}
        <div className="window-controls">
          <button className="window-control-btn btn-min" onClick={handleMinimize} title="最小化">
            <svg width="10" height="10" viewBox="0 0 10 10"><line x1="0" y1="5" x2="10" y2="5" stroke="#94a3b8" strokeWidth="1"/></svg>
          </button>
          <button className="window-control-btn btn-max" onClick={handleMaximize} title={isMaximized ? "元に戻す" : "最大化"}>
            {isMaximized ? (
              <svg width="10" height="10" viewBox="0 0 10 10">
                <path d="M2.5,3.5 L2.5,1.5 L8.5,1.5 L8.5,7.5 L6.5,7.5" fill="none" stroke="#94a3b8" strokeWidth="1"/>
                <rect x="1.5" y="3.5" width="5" height="5" fill="none" stroke="#94a3b8" strokeWidth="1"/>
              </svg>
            ) : (
              <svg width="10" height="10" viewBox="0 0 10 10">
                <rect x="1.5" y="1.5" width="7" height="7" fill="none" stroke="#94a3b8" strokeWidth="1"/>
              </svg>
            )}
          </button>
          <button className="window-control-btn btn-close" onClick={handleClose} title="閉じる">
            <svg width="10" height="10" viewBox="0 0 10 10"><line x1="1.5" y1="1.5" x2="8.5" y2="8.5" stroke="#94a3b8" strokeWidth="1"/><line x1="8.5" y1="1.5" x2="1.5" y2="8.5" stroke="#94a3b8" strokeWidth="1"/></svg>
          </button>
        </div>
      </nav>
      
      {/* ──────────────────────────────────
          Main Editor Workspace
          ────────────────────────────────── */}
      <div className="editor-workspace">
        
        {/* Left Panel: Media & Controls, Mixer or Color */}
        <aside className="media-panel">
          <div className="panel-header" style={{ display: 'flex', gap: '8px', padding: '0 8px', borderBottom: '1px solid var(--border-color)' }}>
            <button
              onClick={() => setActiveTab('cuts')}
              style={{ flex: 1, background: activeTab === 'cuts' ? 'rgba(255,255,255,0.05)' : 'transparent', border: 'none', borderBottom: activeTab === 'cuts' ? '2px solid #3b82f6' : '2px solid transparent', color: activeTab === 'cuts' ? '#e2e8f0' : '#64748b', padding: '6px 0', cursor: 'pointer', fontWeight: 'bold', fontSize: '0.85rem', letterSpacing: '0.05em' }}
            >
              CUTS
            </button>
            <button 
              onClick={() => setActiveTab('mixer')} 
              style={{ flex: 1, background: activeTab === 'mixer' ? 'rgba(255,255,255,0.05)' : 'transparent', border: 'none', borderBottom: activeTab === 'mixer' ? '2px solid #3b82f6' : '2px solid transparent', color: activeTab === 'mixer' ? '#e2e8f0' : '#64748b', padding: '6px 0', cursor: 'pointer', fontWeight: 'bold', fontSize: '0.85rem', letterSpacing: '0.05em' }}
            >
              MIXER
            </button>
            <button 
              onClick={() => setActiveTab('color')} 
              style={{ flex: 1, background: activeTab === 'color' ? 'rgba(255,255,255,0.05)' : 'transparent', border: 'none', borderBottom: activeTab === 'color' ? '2px solid #3b82f6' : '2px solid transparent', color: activeTab === 'color' ? '#e2e8f0' : '#64748b', padding: '6px 0', cursor: 'pointer', fontWeight: 'bold', fontSize: '0.85rem', letterSpacing: '0.05em' }}
            >
              COLOR
            </button>
          </div>
          
          <div className="panel-content" style={{ flex: 1, minHeight: 0, padding: activeTab === 'mixer' ? 0 : 16, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            {activeTab === 'mixer' ? (
              <MixerModal
                tracks={tracks}
                masterState={masterState}
                onClose={() => setActiveTab('cuts')}
                onUpdateAudioState={handleUpdateAudioState}
                onUpdateMasterState={handleUpdateMasterState}
                activeCameraId={activePreviewCameraId}
                onUpdateAudioOffset={handleTrackAudioOffsetChange}
              />
            ) : activeTab === 'color' ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', overflowY: 'auto', flex: 1, minHeight: 0, paddingRight: '4px' }} className="slim-scrollbar">
                {tracks.filter(t => !t.isAudioOnly).map(track => {
                  const color = track.colorState || DEFAULT_COLOR_STATE;
                  const trackColor = getTrackColor(track, tracks);
                  const isPreviewed = track.id === activePreviewCameraId;
                  const isCurrentlyOnAir = track.id === activeCameraId;
                  const isExpanded = expandedColorTrackId === track.id;
                  return (
                    <div
                      key={track.id}
                      style={{
                        background: isPreviewed ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.02)',
                        border: isPreviewed ? `2px solid ${trackColor}` : '1px solid rgba(255,255,255,0.05)',
                        borderRadius: '6px',
                        overflow: 'hidden',
                        display: 'flex',
                        flexDirection: 'column',
                        boxShadow: isPreviewed ? `0 0 12px ${trackColor}2a` : 'none',
                        transition: 'all 0.15s ease-in-out',
                        flexShrink: 0
                      }}
                    >
                      <div
                        onClick={() => {
                          setExpandedColorTrackId(prev => prev === track.id ? null : track.id);
                          handleAngleChangeRequested(track.id);
                        }}
                        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: isPreviewed ? '11px' : '12px', borderBottom: isExpanded ? '1px solid rgba(255,255,255,0.05)' : 'none', cursor: 'pointer' }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#64748b" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" style={{ transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.15s ease-in-out', flexShrink: 0 }}>
                            <polyline points="9 18 15 12 9 6"/>
                          </svg>
                          <span style={{ display: 'inline-block', width: '4px', height: '12px', background: trackColor, borderRadius: '2px' }}></span>
                          <span style={{ fontSize: '0.8rem', fontWeight: 'bold', color: '#f1f5f9' }}>{track.name}</span>
                        </div>
                        {isCurrentlyOnAir && (
                          <div style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '4px',
                            background: '#ef4444',
                            color: '#ffffff',
                            fontSize: '0.65rem',
                            fontWeight: 'bold',
                            padding: '2px 6px',
                            borderRadius: '4px',
                            letterSpacing: '0.05em',
                            boxShadow: '0 0 8px rgba(239, 68, 68, 0.4)'
                          }}>
                            <span style={{
                              display: 'inline-block',
                              width: '5px',
                              height: '5px',
                              borderRadius: '50%',
                              background: '#ffffff',
                              animation: 'pulse 1.5s infinite ease-in-out'
                            }}></span>
                            TIMELINE
                          </div>
                        )}
                      </div>
                      
                      {isExpanded && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', padding: `0 ${isPreviewed ? 11 : 12}px ${isPreviewed ? 11 : 12}px` }}>
                      {/* Temperature */}
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.72rem', color: '#94a3b8' }}>
                          <span>WB (Temp): {color.temperature > 0 ? `+${color.temperature}` : color.temperature}</span>
                          <span 
                            onClick={() => handleUpdateColorState(track.id, { temperature: 0 })}
                            onDoubleClick={() => handleUpdateColorState(track.id, { temperature: 0 })}
                            className="color-reset-btn"
                          >Reset</span>
                        </div>
                        <input 
                          type="range"
                          min="-100"
                          max="100"
                          value={color.temperature}
                          onChange={(e) => handleUpdateColorState(track.id, { temperature: parseInt(e.target.value) })}
                          onMouseUp={handleColorChangeComplete}
                          className="color-slider"
                        />
                      </div>

                      {/* Tint */}
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.72rem', color: '#94a3b8' }}>
                          <span>Tint: {color.tint > 0 ? `+${color.tint}` : color.tint}</span>
                          <span 
                            onClick={() => handleUpdateColorState(track.id, { tint: 0 })}
                            onDoubleClick={() => handleUpdateColorState(track.id, { tint: 0 })}
                            className="color-reset-btn"
                          >Reset</span>
                        </div>
                        <input 
                          type="range"
                          min="-100"
                          max="100"
                          value={color.tint}
                          onChange={(e) => handleUpdateColorState(track.id, { tint: parseInt(e.target.value) })}
                          onMouseUp={handleColorChangeComplete}
                          className="color-slider"
                        />
                      </div>

                      {/* Exposure */}
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.72rem', color: '#94a3b8' }}>
                          <span>Exposure: {color.exposure > 0 ? `+${color.exposure}` : color.exposure}</span>
                          <span 
                            onClick={() => handleUpdateColorState(track.id, { exposure: 0 })}
                            onDoubleClick={() => handleUpdateColorState(track.id, { exposure: 0 })}
                            className="color-reset-btn"
                          >Reset</span>
                        </div>
                        <input 
                          type="range"
                          min="-100"
                          max="100"
                          value={color.exposure}
                          onChange={(e) => handleUpdateColorState(track.id, { exposure: parseInt(e.target.value) })}
                          onMouseUp={handleColorChangeComplete}
                          className="color-slider"
                        />
                      </div>

                      {/* Contrast */}
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.72rem', color: '#94a3b8' }}>
                          <span>Contrast: {color.contrast > 0 ? `+${color.contrast}` : color.contrast}</span>
                          <span 
                            onClick={() => handleUpdateColorState(track.id, { contrast: 0 })}
                            onDoubleClick={() => handleUpdateColorState(track.id, { contrast: 0 })}
                            className="color-reset-btn"
                          >Reset</span>
                        </div>
                        <input 
                          type="range"
                          min="-100"
                          max="100"
                          value={color.contrast}
                          onChange={(e) => handleUpdateColorState(track.id, { contrast: parseInt(e.target.value) })}
                          onMouseUp={handleColorChangeComplete}
                          className="color-slider"
                        />
                      </div>
                      </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                  <div
                    ref={cutsContainerRef}
                    className="slim-scrollbar" 
                    style={{ 
                      display: 'flex', 
                      flexDirection: 'column', 
                      gap: '5px', 
                      flex: 1, 
                      overflowY: 'auto', 
                      paddingRight: '4px',
                      position: 'relative'
                    }}
                  >
                    {(() => {
                      const activeCut = [...cuts].reverse().find(c => c.timeSeconds <= currentTime);
                      return cuts.length === 0 ? (
                        <div style={{ color: '#475569', fontSize: '0.8rem', textAlign: 'center', padding: '12px 0' }}>カットなし</div>
                      ) : (
                        cuts.map((cut, idx) => {
                          const track = tracks.find(t => t.id === cut.cameraId);
                          const trackColor = track ? getTrackColor(track, tracks) : '#64748b';
                          const isCutActive = activeCut?.id === cut.id;
                          return (
                            <div 
                              key={cut.id}
                              id={`cut-card-${cut.id}`}
                              onClick={() => { handleTimeChange(cut.timeSeconds); setPreviewOverrideCameraId(null); }}
                              onContextMenu={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                setContextMenu({
                                  x: e.clientX,
                                  y: e.clientY,
                                  cutId: cut.id,
                                  cutTime: cut.timeSeconds
                                });
                              }}
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: '5px',
                                background: isCutActive ? 'rgba(59, 130, 246, 0.06)' : 'rgba(0, 0, 0, 0.2)',
                                border: isCutActive ? '1px solid rgba(59, 130, 246, 0.35)' : '1px solid rgba(255, 255, 255, 0.05)',
                                borderRadius: '4px',
                                padding: '3px 6px 3px 0',
                                transition: 'all 0.2s ease',
                                boxShadow: isCutActive ? '0 2px 8px rgba(59, 130, 246, 0.1)' : 'none',
                                height: '34px', // Expanded height from 28px to 34px
                                flexShrink: 0,
                                boxSizing: 'border-box',
                                cursor: 'pointer',
                                overflow: 'hidden'
                              }}
                            >
                              {/* カメラ色インジケータ ＆ アングル選択 */}
                              <div 
                                className="cut-card-angle-indicator"
                                style={{
                                  width: '18px',
                                  height: '100%',
                                  backgroundColor: trackColor,
                                  borderRadius: '3px 0 0 3px',
                                  cursor: 'pointer',
                                  flexShrink: 0,
                                  position: 'relative',
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'center'
                                }}
                                title={`アングル変更 | 現在: ${track?.name || 'Unknown'}`}
                                onClick={e => e.stopPropagation()}
                              >
                                <select
                                  value={cut.cameraId}
                                  onChange={(e) => {
                                    e.stopPropagation();
                                    handleCutUpdate(cut.id, { cameraId: e.target.value });
                                  }}
                                  onClick={e => e.stopPropagation()}
                                  style={{
                                    position: 'absolute',
                                    top: 0, left: 0, width: '100%', height: '100%',
                                    opacity: 0,
                                    cursor: 'pointer'
                                  }}
                                >
                                  {tracks.filter(t => !t.isAudioOnly).map(t => (
                                    <option key={t.id} value={t.id}>{t.name}</option>
                                  ))}
                                </select>
                                <svg width="6" height="6" viewBox="0 0 24 24" fill="#ffffff" stroke="#ffffff" strokeWidth="2">
                              <polygon points="6 9 12 15 18 9"/>
                                </svg>
                              </div>

                              <div style={{ display: 'flex', alignItems: 'center', flexShrink: 0, marginLeft: '4px' }}>
                                <span style={{ fontSize: '0.72rem', fontWeight: 'bold', color: isCutActive ? '#3b82f6' : '#64748b', minWidth: '22px', textAlign: 'left' }}>
                                  #{idx + 1}
                                </span>
                              </div>

                              <div style={{ width: '12px', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                                {isCutActive ? (
                                  <div 
                                    className="status-dot processing"
                                    style={{
                                      width: '8px',
                                      height: '8px',
                                      borderRadius: '50%',
                                      backgroundColor: '#ef4444',
                                      boxShadow: '0 0 6px #ef4444',
                                      flexShrink: 0
                                    }}
                                    title="現在再生中セグメントの開始点"
                                  />
                                ) : (
                                  <div style={{ width: '8px', height: '8px', flexShrink: 0 }} />
                                )}
                              </div>

                              {/* タイムコード（ドラッグ調整・クリックシーク） */}
                              <div 
                                className={`cut-card-timecode ${isCutActive ? 'active' : ''}`}
                                onMouseDown={(e) => handleCutTimeDragMouseDown(e, cut)}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleTimeChange(cut.timeSeconds);
                                }}
                                style={{
                                  cursor: 'ew-resize',
                                  fontFamily: 'monospace',
                                  backgroundColor: isCutActive ? 'rgba(59, 130, 246, 0.15)' : 'rgba(255, 255, 255, 0.05)',
                                  border: isCutActive ? '1px solid rgba(59, 130, 246, 0.3)' : '1px solid rgba(255, 255, 255, 0.1)',
                                  color: isCutActive ? '#60a5fa' : '#cbd5e1',
                                  padding: '1px 4px',
                                  borderRadius: '3px',
                                  fontWeight: 'bold',
                                  fontSize: '0.7rem',
                                  userSelect: 'none',
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  gap: '2px',
                                  flexShrink: 0
                                }}
                                title="ドラッグで位置調整 / クリックで再生位置へジャンプ"
                              >
                                {formatTimecode(cut.timeSeconds)}
                              </div>

                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handlePreviewFrom(cut.timeSeconds);
                                }}
                                title="このカット位置からプレビュー再生"
                                style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                  width: '16px',
                                  height: '16px',
                                  flexShrink: 0,
                                  padding: 0,
                                  border: 'none',
                                  borderRadius: '3px',
                                  background: 'transparent',
                                  color: '#64748b',
                                  fontSize: '0.65rem',
                                  cursor: 'pointer',
                                  transition: 'color 0.12s, background 0.12s'
                                }}
                                onMouseEnter={(e) => {
                                  e.currentTarget.style.color = '#60a5fa';
                                  e.currentTarget.style.background = 'rgba(59, 130, 246, 0.15)';
                                }}
                                onMouseLeave={(e) => {
                                  e.currentTarget.style.color = '#64748b';
                                  e.currentTarget.style.background = 'transparent';
                                }}
                              >▶</button>

                              {/* トランジションカラーバッジ(プルダウン展開可能) & トランジション時間 (時間バッジの左側に並べる) */}
                              <div style={{ display: 'flex', alignItems: 'center', gap: '3px', flexShrink: 0 }} onClick={e => e.stopPropagation()}>
                                {/* プルダウン展開できるカラーバッジ (C, F, B, W バッジ重ね) */}
                                <div 
                                  className="cut-card-transition-type"
                                  style={{ position: 'relative', width: '20px', height: '20px', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}
                                >
                                  {/* 見た目のカスタムバッジ */}
                                  <div 
                                    style={{
                                      position: 'absolute',
                                      top: 0, left: 0, right: 0, bottom: 0,
                                      display: 'flex',
                                      alignItems: 'center',
                                      justifyContent: 'center',
                                      fontSize: '0.68rem',
                                      fontWeight: 'bold',
                                      color: cut.transition === 'cut' ? '#94a3b8' : 
                                             cut.transition === 'crossfade' ? '#a855f7' : 
                                             cut.transition === 'dip_to_black' ? '#ffffff' : '#000000',
                                      background: cut.transition === 'cut' ? 'transparent' :
                                                  cut.transition === 'crossfade' ? 'rgba(168, 85, 247, 0.15)' :
                                                  cut.transition === 'dip_to_black' ? '#1e293b' : '#ffffff',
                                      border: cut.transition === 'cut' ? '1px solid rgba(148, 163, 184, 0.3)' :
                                              cut.transition === 'crossfade' ? '1px solid rgba(168, 85, 247, 0.4)' :
                                              cut.transition === 'dip_to_black' ? '1px solid #0f172a' : '1px solid #cbd5e1',
                                      borderRadius: '3px',
                                      pointerEvents: 'none',
                                      userSelect: 'none'
                                    }}
                                    title={cut.transition === 'cut' ? 'Cut (カット即時切替) - クリックで変更' :
                                           cut.transition === 'crossfade' ? 'Fade (クロスフェード) - クリックで変更' :
                                           cut.transition === 'dip_to_black' ? 'Black (暗転フェード) - クリックで変更' : 'White (明転フェード) - クリックで変更'}
                                  >
                                    {cut.transition === 'cut' ? 'C' :
                                     cut.transition === 'crossfade' ? 'F' :
                                     cut.transition === 'dip_to_black' ? 'B' : 'W'}
                                  </div>

                                  {/* 透明な本物の select */}
                                  <select
                                    value={cut.transition}
                                    onChange={(e) => {
                                      e.stopPropagation();
                                      const type = e.target.value as any;
                                      const duration = type === 'cut' ? 0 : (cut.transitionDuration > 0 ? cut.transitionDuration : 0.5);
                                      handleCutUpdate(cut.id, { transition: type, transitionDuration: duration });
                                    }}
                                    style={{
                                      position: 'absolute',
                                      top: 0, left: 0, width: '100%', height: '100%',
                                      opacity: 0,
                                      cursor: 'pointer',
                                      outline: 'none',
                                      margin: 0,
                                      padding: 0
                                    }}
                                  >
                                    {TRANSITION_OPTIONS.map(o => (
                                      <option key={o.value} value={o.value}>{o.label}</option>
                                    ))}
                                  </select>
                                </div>

                                {/* トランジション時間 (ドラッグ可能) */}
                                {cut.transition !== 'cut' && (
                                  <div
                                    className="cut-card-transition-duration"
                                    onMouseDown={(e) => handleCutDurationDragMouseDown(e, cut)}
                                    style={{
                                      cursor: 'ew-resize',
                                      fontFamily: 'monospace',
                                      backgroundColor: 'rgba(255, 255, 255, 0.08)',
                                      border: '1px solid rgba(255, 255, 255, 0.2)',
                                      color: '#f8fafc',
                                      padding: '1px 3px',
                                      borderRadius: '3px',
                                      fontWeight: 'bold',
                                      fontSize: '0.65rem',
                                      userSelect: 'none',
                                      flexShrink: 0
                                    }}
                                    title="左右にドラッグして時間を調整"
                                  >
                                    {cut.transitionDuration.toFixed(1)}s
                                  </div>
                                )}
                              </div>
                            </div>
                          );
                        })
                      );
                    })()}
                  </div>
              </div>
            )}
          </div>
        </aside>

        {/* Center: Preview Workspace */}
        <main className="preview-workspace" style={{ position: 'relative' }}>
          <div className="preview-container" style={{ position: 'relative' }}>
              <VideoPreview 
                tracks={tracks}
                cuts={cuts}
                currentTime={currentTime}
                isPlaying={isPlaying}
                masterVolume={masterVolume}
                onAngleChangeRequested={handleAngleChangeRequested}
                isDraggingOffset={isDraggingOffset}
                isGridView={isGridView}
                onToggleGridView={() => setIsGridView(prev => !prev)}
                previewOverrideCameraId={previewOverrideCameraId}
                onClearPreviewOverride={() => setPreviewOverrideCameraId(null)}
                exportRange={exportRange}
                onForceAddCut={handleForceAddCut}
                onSyncStateChange={(syncing) => { isVideoSyncingRef.current = syncing; }}
                onSetExportStart={handleSetExportStartAtCurrentTime}
                onSetExportEnd={handleSetExportEndAtCurrentTime}
              />

              {/* Floating Volume Overlay - preview-container内の右下に配置 */}
              <div className="preview-volume-overlay">
                <div className="volume-slider-container">
                  <input
                    type="range"
                    orient="vertical"
                    min="0" max="1" step="0.01"
                    value={masterVolume}
                    onChange={e => setMasterVolume(Number(e.target.value))}
                    className="volume-slider-vertical"
                    style={{
                      ['--percent' as any]: `${masterVolume * 100}%`
                    }}
                  />
                </div>
                <button 
                  className="volume-overlay-btn" 
                  onClick={handleToggleMute}
                  title={`音量調整 (${Math.round(masterVolume * 100)}%) (Mute)`}
                >
                  {masterVolume === 0 ? (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                      <line x1="22" y1="9" x2="16" y2="15" />
                      <line x1="16" y1="9" x2="22" y2="15" />
                    </svg>
                  ) : masterVolume <= 0.5 ? (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                      <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                    </svg>
                  ) : (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                      <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
                      <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                    </svg>
                  )}
                </button>
              </div>
          </div>

          <div className="transport-controls">
            {/* Left: Timecode + Timeline follow + Cut/Transition */}
            <div style={{ display: 'flex', alignItems: 'center', flex: 1, gap: '16px' }}>
              <div
                className="timecode"
                onMouseDown={handleTimecodeMouseDown}
                title={"左右にドラッグして1フレーム単位でスクラブ調整\n← → でフレーム送り / Shift+← → で5秒移動"}
              >
                {formatTimecode(currentTime)}
              </div>

              <div style={{ width: '1px', height: '22px', background: 'rgba(255,255,255,0.1)', flexShrink: 0 }} />

              {/* タイムライン追従に戻るボタン */}
              <button
                className="btn btn-transport-flat"
                onClick={() => setPreviewOverrideCameraId(null)}
                disabled={previewOverrideCameraId === null || tracks.length === 0}
                data-tooltip={previewOverrideCameraId !== null ? "タイムライン追従に戻る" : "タイムライン追従中"}
                style={{
                  color: previewOverrideCameraId !== null ? '#60a5fa' : '#475569',
                  opacity: previewOverrideCameraId !== null ? 1 : 0.35,
                  cursor: previewOverrideCameraId !== null ? 'pointer' : 'default',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: '32px',
                  height: '32px',
                  borderRadius: '6px',
                  background: previewOverrideCameraId !== null ? 'rgba(59, 130, 246, 0.15)' : 'transparent',
                  border: previewOverrideCameraId !== null ? '1px solid rgba(59, 130, 246, 0.3)' : '1px solid transparent',
                  transition: 'all 0.2s ease',
                  padding: 0
                }}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
                  <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
                </svg>
              </button>

              {/* 手動カット & トランジション設定グループ (一体化カプセル) */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  background: 'rgba(0, 0, 0, 0.25)',
                  border: '1px solid #1e293b',
                  borderRadius: '6px',
                  padding: '2px 4px',
                  gap: '4px',
                  height: '38px',
                  boxSizing: 'border-box'
                }}
              >
                {/* 手動カットボタン (左側) */}
                <button
                  className="btn btn-transport-flat"
                  onClick={handleManualCut}
                  disabled={tracks.length === 0}
                  style={{ width: '32px', height: '32px', borderRadius: '4px' }}
                  data-tooltip="現在の位置でカットを追加する (C)"
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/>
                    <line x1="20" y1="4" x2="8.12" y2="15.88"/><line x1="14.47" y1="14.48" x2="20" y2="20"/><line x1="8.12" y1="8.12" x2="12" y2="12"/>
                  </svg>
                </button>

                {/* 分割線 */}
                <div style={{ width: '1px', height: '20px', background: 'rgba(255,255,255,0.1)' }} />

                {/* デフォルトトランジション設定 (右側) */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '4px', padding: '0', boxSizing: 'border-box' }}>
                  {/* 種類選択 (C, F, B, W バッジ重ね) */}
                  <div
                    className="default-transition-type-badge"
                    data-tooltip="カット時に適用されるデフォルトトランジション"
                    style={{ position: 'relative', width: '24px', height: '24px', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}
                  >
                    <div
                      style={{
                        position: 'absolute',
                        top: 0, left: 0, right: 0, bottom: 0,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: '0.78rem',
                        fontWeight: 'bold',
                        color: preferences.defaultTransitionType === 'cut' ? '#94a3b8' :
                               preferences.defaultTransitionType === 'crossfade' ? '#a855f7' :
                               preferences.defaultTransitionType === 'dip_to_black' ? '#ffffff' : '#000000',
                        background: preferences.defaultTransitionType === 'cut' ? 'transparent' :
                                    preferences.defaultTransitionType === 'crossfade' ? 'rgba(168, 85, 247, 0.15)' :
                                    preferences.defaultTransitionType === 'dip_to_black' ? '#1e293b' : '#ffffff',
                        border: preferences.defaultTransitionType === 'cut' ? '1px solid rgba(148, 163, 184, 0.3)' :
                                preferences.defaultTransitionType === 'crossfade' ? '1px solid rgba(168, 85, 247, 0.4)' :
                                preferences.defaultTransitionType === 'dip_to_black' ? '1px solid #0f172a' : '1px solid #cbd5e1',
                        borderRadius: '4px',
                        pointerEvents: 'none',
                        userSelect: 'none'
                      }}
                    >
                      {preferences.defaultTransitionType === 'cut' ? 'C' :
                       preferences.defaultTransitionType === 'crossfade' ? 'F' :
                       preferences.defaultTransitionType === 'dip_to_black' ? 'B' : 'W'}
                    </div>
                    <select
                      value={preferences.defaultTransitionType || 'cut'}
                      onChange={e => {
                        const nextType = e.target.value as any;
                        const nextDuration = nextType === 'cut' ? 0 : (preferences.defaultTransitionDuration || 0.5);
                        const updated = {
                          ...preferences,
                          defaultTransitionType: nextType,
                          defaultTransitionDuration: nextDuration
                        };
                        setPreferences(updated);
                        localStorage.setItem('mcse_preferences', JSON.stringify(updated));
                      }}
                      style={{
                        position: 'absolute',
                        top: 0, left: 0, width: '100%', height: '100%',
                        opacity: 0,
                        cursor: 'pointer',
                        outline: 'none',
                        margin: 0,
                        padding: 0
                      }}
                    >
                      {TRANSITION_OPTIONS.map(o => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                      ))}
                    </select>
                  </div>
                  {(preferences.defaultTransitionType || 'cut') !== 'cut' && (
                    <div
                      className="default-transition-duration-badge"
                      onMouseDown={handleDefaultDurationDragMouseDown}
                      style={{
                        cursor: 'ew-resize',
                        height: '24px',
                        padding: '0 6px',
                        background: 'rgba(255, 255, 255, 0.08)',
                        borderRadius: '4px',
                        border: '1px solid rgba(255, 255, 255, 0.2)',
                        color: '#f8fafc',
                        fontSize: '0.78rem',
                        fontWeight: 'bold',
                        userSelect: 'none',
                        fontFamily: 'monospace',
                        display: 'inline-flex',
                        alignItems: 'center',
                        boxSizing: 'border-box',
                        transition: 'all 0.15s'
                      }}
                      title="左右にドラッグしてデフォルトトランジション時間を微調整"
                    >
                      {(preferences.defaultTransitionDuration || 0.5).toFixed(1)}s
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Center: Prev cut + Play/Pause + Next cut */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
              {/* 前のカットへ */}
              <button
                className="btn btn-transport-flat"
                onClick={handlePrevCut}
                disabled={tracks.length === 0}
                data-tooltip="前のカットへ (↑ Up)"
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polygon points="19 20 9 12 19 4 19 20" />
                  <line x1="5" y1="4" x2="5" y2="20" />
                </svg>
              </button>

              {/* Play/Pause Button (Enlarged) */}
              <button
                className={`btn btn-play-pause ${isPlaying ? 'playing' : 'paused'}`}
                onClick={handlePlayPause}
                data-tooltip={isPlaying ? "一時停止 (Space)" : "再生 (Space)"}
              >
                {isPlaying ? (
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="4" x2="18" y2="20"/><line x1="6" y1="4" x2="6" y2="20"/></svg>
                ) : (
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                )}
              </button>

              {/* 次のカットへ */}
              <button
                className="btn btn-transport-flat"
                onClick={handleNextCut}
                disabled={tracks.length === 0 || cuts.length === 0}
                data-tooltip="次のカットへ (↓ Down)"
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polygon points="5 4 15 12 5 20 5 4" />
                  <line x1="19" y1="4" x2="19" y2="20" />
                </svg>
              </button>
            </div>

            {/* Right: IN/OUT range */}
            <div style={{ display: 'flex', alignItems: 'center', flex: 1, justifyContent: 'flex-end' }}>
              {/* イン・アウト範囲設定コントロールパネル (常に表示、useRange の有無でアクティブ状態変化) */}
              <div 
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  background: 'rgba(255, 255, 255, 0.03)',
                  border: '1px solid rgba(255, 255, 255, 0.08)',
                  borderRadius: '6px',
                  padding: '2px 8px',
                  gap: '12px',
                  height: '38px',
                  boxSizing: 'border-box',
                  transition: 'opacity 0.2s, border-color 0.2s'
                }}
              >
                {/* 始点 (IN) ブロック */}
                <div 
                  style={{ 
                    display: 'flex', 
                    alignItems: 'center', 
                    gap: '8px'
                  }}
                >
                  {/* 現在の位置を始点に設定ボタン */}
                  <button
                    className="btn btn-transport-flat"
                    onClick={handleSetExportStartAtCurrentTime}
                    disabled={tracks.length === 0}
                    data-tooltip="現在の位置を書き出し始点に設定 ([)"
                    style={{ 
                      padding: 0, 
                      width: '32px', 
                      height: '32px', 
                      display: 'flex', 
                      alignItems: 'center', 
                      justifyContent: 'center',
                      background: 'rgba(255, 255, 255, 0.03)',
                      border: '1px solid rgba(255, 255, 255, 0.08)',
                      borderRadius: '4px',
                      color: exportRange.useRange ? '#f3f4f6' : 'rgba(255, 255, 255, 0.2)',
                      transition: 'all 0.15s'
                    }}
                  >
                    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M19 4H9a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10" />
                      <path d="M12 12h5" />
                      <polyline points="14 9 17 12 14 15" />
                    </svg>
                  </button>
                  
                  {/* 始点値設定グループ（未設定時は半透明化） */}
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                      opacity: exportRange.useRange ? 1 : 0.4,
                      transition: 'opacity 0.2s'
                    }}
                  >
                    {/* 時間微調整バッジ (useRange有効時にドラッグで変更可能) */}
                    {exportRange.useRange ? (
                      <div
                        className="range-limit-badge"
                        onMouseDown={(e) => handleTransportRangeLimitDragMouseDown(e, 'start')}
                        style={{
                          cursor: 'ew-resize',
                          height: '24px',
                          padding: '0 6px',
                          background: 'rgba(255, 255, 255, 0.05)',
                          borderRadius: '4px',
                          border: '1px solid rgba(255, 255, 255, 0.15)',
                          color: '#e2e8f0',
                          fontSize: '0.75rem',
                          fontWeight: 'bold',
                          userSelect: 'none',
                          fontFamily: 'monospace',
                          display: 'inline-flex',
                          alignItems: 'center',
                          boxSizing: 'border-box'
                        }}
                        title="左右にドラッグして始点を微調整"
                      >
                        {formatTimecode(exportRange.start)}
                      </div>
                    ) : (
                      <div
                        style={{
                          height: '24px',
                          padding: '0 6px',
                          background: 'rgba(255, 255, 255, 0.02)',
                          borderRadius: '4px',
                          border: '1px solid rgba(255, 255, 255, 0.05)',
                          color: 'rgba(255, 255, 255, 0.25)',
                          fontSize: '0.75rem',
                          fontWeight: 'bold',
                          userSelect: 'none',
                          fontFamily: 'monospace',
                          display: 'inline-flex',
                          alignItems: 'center',
                          boxSizing: 'border-box'
                        }}
                      >
                        --:--:--:--
                      </div>
                    )}

                    {/* プレビューボタン */}
                    <button
                      className="btn btn-transport-flat"
                      disabled={!exportRange.useRange}
                      onClick={() => { handlePreviewFrom(exportRange.start); }}
                      style={{
                        padding: 0,
                        width: '22px',
                        height: '22px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        opacity: exportRange.useRange ? 1 : 0.3
                      }}
                      data-tooltip="始点からプレビュー再生"
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                        <polygon points="5 3 19 12 5 21 5 3"/>
                      </svg>
                    </button>

                    {/* フェードインバッジ（クリックでON/OFF、ドラッグで時間調整。チェックボックス省略） */}
                    {exportRange.useRange && (
                      <div
                        onMouseDown={(e) => handleTransportFadeDurationDragMouseDown(e, 'fadeIn')}
                        className="fade-badge"
                        style={{
                          cursor: 'ew-resize',
                          height: '24px',
                          padding: '0 6px',
                          background: exportRange.fadeIn ? 'rgba(255, 255, 255, 0.08)' : 'rgba(255, 255, 255, 0.01)',
                          borderRadius: '4px',
                          border: exportRange.fadeIn 
                            ? '1px solid rgba(255, 255, 255, 0.2)' 
                            : '1px dashed rgba(255, 255, 255, 0.08)',
                          color: exportRange.fadeIn ? '#f8fafc' : 'rgba(255, 255, 255, 0.25)',
                          fontSize: '0.72rem',
                          fontWeight: 'bold',
                          userSelect: 'none',
                          fontFamily: 'monospace',
                          display: 'inline-flex',
                          alignItems: 'center',
                          boxSizing: 'border-box',
                          transition: 'all 0.15s'
                        }}
                        title="クリックでフェードインを有効/無効、ドラッグでフェード時間を調整"
                      >
                        {exportRange.fadeIn ? `${(exportRange.fadeInDuration ?? 0.5).toFixed(1)}s` : 'Fade'}
                      </div>
                    )}
                  </div>
                </div>

                {/* 分割線 */}
                <div style={{ width: '1px', height: '18px', background: 'rgba(255,255,255,0.08)' }} />

                {/* 終点 (OUT) ブロック */}
                <div 
                  style={{ 
                    display: 'flex', 
                    alignItems: 'center', 
                    gap: '8px'
                  }}
                >
                  {/* 現在の位置を終点に設定ボタン */}
                  <button
                    className="btn btn-transport-flat"
                    onClick={handleSetExportEndAtCurrentTime}
                    disabled={tracks.length === 0}
                    data-tooltip="現在の位置を書き出し終点に設定 (])"
                    style={{ 
                      padding: 0, 
                      width: '32px', 
                      height: '32px', 
                      display: 'flex', 
                      alignItems: 'center', 
                      justifyContent: 'center',
                      background: 'rgba(255, 255, 255, 0.03)',
                      border: '1px solid rgba(255, 255, 255, 0.08)',
                      borderRadius: '4px',
                      color: exportRange.useRange ? '#f3f4f6' : 'rgba(255, 255, 255, 0.2)',
                      transition: 'all 0.15s'
                    }}
                  >
                    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M5 4h10a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5" />
                      <path d="M12 12H7" />
                      <polyline points="10 9 7 12 10 15" />
                    </svg>
                  </button>

                  {/* 終点値設定グループ（未設定時は半透明化） */}
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                      opacity: exportRange.useRange ? 1 : 0.4,
                      transition: 'opacity 0.2s'
                    }}
                  >
                    {/* 時間微調整バッジ (useRange有効時にドラッグで変更可能) */}
                    {exportRange.useRange ? (
                      <div
                        className="range-limit-badge"
                        onMouseDown={(e) => handleTransportRangeLimitDragMouseDown(e, 'end')}
                        style={{
                          cursor: 'ew-resize',
                          height: '24px',
                          padding: '0 6px',
                          background: 'rgba(255, 255, 255, 0.05)',
                          borderRadius: '4px',
                          border: '1px solid rgba(255, 255, 255, 0.15)',
                          color: '#e2e8f0',
                          fontSize: '0.75rem',
                          fontWeight: 'bold',
                          userSelect: 'none',
                          fontFamily: 'monospace',
                          display: 'inline-flex',
                          alignItems: 'center',
                          boxSizing: 'border-box'
                        }}
                        title="左右にドラッグして終点を微調整"
                      >
                        {formatTimecode(exportRange.end)}
                      </div>
                    ) : (
                      <div
                        style={{
                          height: '24px',
                          padding: '0 6px',
                          background: 'rgba(255, 255, 255, 0.02)',
                          borderRadius: '4px',
                          border: '1px solid rgba(255, 255, 255, 0.05)',
                          color: 'rgba(255, 255, 255, 0.25)',
                          fontSize: '0.75rem',
                          fontWeight: 'bold',
                          userSelect: 'none',
                          fontFamily: 'monospace',
                          display: 'inline-flex',
                          alignItems: 'center',
                          boxSizing: 'border-box'
                        }}
                      >
                        --:--:--:--
                      </div>
                    )}

                    {/* プレビューボタン */}
                    <button
                      className="btn btn-transport-flat"
                      disabled={!exportRange.useRange}
                      onClick={() => { handlePreviewFrom(Math.max(0, exportRange.end - 5.0)); }}
                      style={{
                        padding: 0,
                        width: '22px',
                        height: '22px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        opacity: exportRange.useRange ? 1 : 0.3
                      }}
                      data-tooltip="終点の5秒前からプレビュー再生"
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                        <polygon points="5 3 19 12 5 21 5 3"/>
                      </svg>
                    </button>

                    {/* フェードアウトバッジ（クリックでON/OFF、ドラッグで時間調整。チェックボックス省略） */}
                    {exportRange.useRange && (
                      <div
                        onMouseDown={(e) => handleTransportFadeDurationDragMouseDown(e, 'fadeOut')}
                        className="fade-badge"
                        style={{
                          cursor: 'ew-resize',
                          height: '24px',
                          padding: '0 6px',
                          background: exportRange.fadeOut ? 'rgba(255, 255, 255, 0.08)' : 'rgba(255, 255, 255, 0.01)',
                          borderRadius: '4px',
                          border: exportRange.fadeOut 
                            ? '1px solid rgba(255, 255, 255, 0.2)' 
                            : '1px dashed rgba(255, 255, 255, 0.08)',
                          color: exportRange.fadeOut ? '#f8fafc' : 'rgba(255, 255, 255, 0.25)',
                          fontSize: '0.72rem',
                          fontWeight: 'bold',
                          userSelect: 'none',
                          fontFamily: 'monospace',
                          display: 'inline-flex',
                          alignItems: 'center',
                          boxSizing: 'border-box',
                          transition: 'all 0.15s'
                        }}
                        title="クリックでフェードアウトを有効/無効、ドラッグでフェード時間を調整"
                      >
                        {exportRange.fadeOut ? `${(exportRange.fadeOutDuration ?? 2.0).toFixed(1)}s` : 'Fade'}
                      </div>
                    )}
                  </div>
                </div>

                {/* 範囲クリア（✕）ボタン */}
                {exportRange.useRange && (
                  <>
                    <div style={{ width: '1px', height: '18px', background: 'rgba(255,255,255,0.08)' }} />
                    <button
                      className="btn btn-transport-flat"
                      onClick={() => {
                        handleExportRangeChange(prev => ({ ...prev, useRange: false }));
                        setStatusText("書き出し範囲設定をクリアしました");
                      }}
                      style={{
                        padding: 0,
                        width: '20px',
                        height: '20px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        color: 'rgba(255, 255, 255, 0.4)',
                        fontSize: '0.75rem',
                        lineHeight: 1
                      }}
                      title="書き出し範囲設定を解除 (範囲をクリア)"
                    >
                      ✕
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        </main>

      </div>
      
      {/* ──────────────────────────────────
          Bottom Timeline
          ────────────────────────────────── */}
      <footer className="timeline-workspace">
          <Timeline
            tracks={tracks}
            cuts={cuts}
            pixelsPerSecond={pixelsPerSecond}
            currentTime={currentTime}
            duration={duration}
            onTimeChange={handleTimeChange}
            onCutDelete={handleCutDelete}
            onCutUpdate={handleCutUpdate}
            onCutAdd={handleCutRequested}
            onTrackOffsetChange={handleTrackOffsetChange}
            exportRange={exportRange}
            onExportRangeChange={handleExportRangeChange}
            onAngleChangeRequested={handleAngleChangeRequested}
            onZoomChange={setPixelsPerSecond}
            activePreviewCameraId={activePreviewCameraId}
            isPlaying={isPlaying}
            onPlayingChange={handlePlayingChangeFromTimeline}
            onSyncTrack={handleSyncTrack}
            onSyncAllTracks={handleSyncAllTracks}
            onOffsetBadgeMouseDown={handleOffsetBadgeMouseDown}
            onOffsetBadgeDoubleClick={handleOffsetBadgeDoubleClick}
            onToggleLockTrack={handleToggleLockTrack}
            onTrackNameChange={handleTrackNameChange}
            onTrackDelete={handleDeleteTrack}
            onTrackReorder={handleTrackReorder}
            isProcessing={isProcessing}
          />
      </footer>

      {isExportModalOpen && (
        <ExportModal
          tracks={tracks}
          cuts={cuts}
          duration={duration}
          onClose={() => setIsExportModalOpen(false)}
          exportRange={exportRange}
          projectFps={preferences.projectFps ?? 60}
          masterState={masterState}
        />
      )}

      {contextMenu && (
        <div 
          style={{
            position: 'fixed',
            top: contextMenu.y,
            left: contextMenu.x,
            background: '#1e293b',
            border: '1px solid #475569',
            borderRadius: '4px',
            boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
            zIndex: 1000,
            padding: '4px 0',
            width: '165px'
          }}
          onContextMenu={e => e.preventDefault()}
        >
          {(() => {
            const cut = cuts.find(c => c.id === contextMenu.cutId);
            if (!cut) return null;

            const itemStyle = (disabled?: boolean): React.CSSProperties => ({
              width: '100%', padding: '6px 12px', background: 'transparent', border: 'none',
              color: disabled ? '#64748b' : '#e2e8f0', textAlign: 'left',
              cursor: disabled ? 'default' : 'pointer', fontSize: '0.75rem',
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
            });
            const onEnter = (disabled?: boolean) => (e: React.MouseEvent<HTMLButtonElement>) => {
              if (!disabled) e.currentTarget.style.background = 'rgba(255,255,255,0.08)';
            };
            const onLeave = (e: React.MouseEvent<HTMLButtonElement>) => { e.currentTarget.style.background = 'transparent'; };
            const divider = <div style={{ borderTop: '1px solid #334155', margin: '4px 0' }} />;
            const sectionLabel = (label: string) => (
              <div style={{ padding: '4px 12px 2px', fontSize: '0.65rem', color: '#64748b', whiteSpace: 'nowrap' }}>{label}</div>
            );

            return (
              <>
                <div style={{ padding: '4px 12px', fontSize: '0.7rem', color: '#64748b', borderBottom: '1px solid #334155', marginBottom: '4px', whiteSpace: 'nowrap' }}>
                  カット: {contextMenu.cutTime !== undefined ? formatTimecode(contextMenu.cutTime) : ''}
                </div>

                <button
                  onClick={() => {
                    handleTimeChange(cut.timeSeconds);
                    setPreviewOverrideCameraId(null);
                    setContextMenu(null);
                  }}
                  style={itemStyle()}
                  onMouseEnter={onEnter()}
                  onMouseLeave={onLeave}
                >
                  この位置にジャンプ
                </button>

                {divider}
                {sectionLabel('アングルを変更')}
                {tracks.filter(t => !t.isAudioOnly).map(t => {
                  const isCurrent = t.id === cut.cameraId;
                  return (
                    <button
                      key={t.id}
                      disabled={isCurrent}
                      onClick={() => { if (!isCurrent) { handleCutUpdate(cut.id, { cameraId: t.id }); setContextMenu(null); } }}
                      style={itemStyle(isCurrent)}
                      title={t.name}
                      onMouseEnter={onEnter(isCurrent)}
                      onMouseLeave={onLeave}
                    >
                      {isCurrent ? '✓ ' : ''}{t.name}
                    </button>
                  );
                })}

                {divider}
                {sectionLabel('トランジションを変更')}
                {TRANSITION_OPTIONS.map(opt => {
                  const isCurrent = cut.transition === opt.value;
                  return (
                    <button
                      key={opt.value}
                      disabled={isCurrent}
                      onClick={() => {
                        if (isCurrent) return;
                        const duration = opt.value === 'cut' ? 0 : (cut.transitionDuration > 0 ? cut.transitionDuration : 0.5);
                        handleCutUpdate(cut.id, { transition: opt.value, transitionDuration: duration });
                        setContextMenu(null);
                      }}
                      style={itemStyle(isCurrent)}
                      title={opt.label}
                      onMouseEnter={onEnter(isCurrent)}
                      onMouseLeave={onLeave}
                    >
                      {isCurrent ? '✓ ' : ''}{opt.label}
                    </button>
                  );
                })}

                {divider}
                <button
                  onClick={() => {
                    handleCutDelete(cut.id);
                    setContextMenu(null);
                  }}
                  style={{ ...itemStyle(), color: '#f87171', fontWeight: 'bold' }}
                  onMouseEnter={e => e.currentTarget.style.background = 'rgba(239, 68, 68, 0.1)'}
                  onMouseLeave={onLeave}
                >
                  カットを削除
                </button>
              </>
            );
          })()}
        </div>
      )}
      {isPreferencesOpen && (
        <PreferencesModal
          onClose={() => setIsPreferencesOpen(false)}
          onSave={(newPrefs) => setPreferences(newPrefs)}
        />
      )}
      {isShortcutHelpOpen && (
        <ShortcutHelpModal onClose={() => setIsShortcutHelpOpen(false)} />
      )}

      {refMediaConfirm && (
        <div style={{
          position: 'fixed',
          top: 0, left: 0, right: 0, bottom: 0,
          backgroundColor: 'rgba(0, 0, 0, 0.6)',
          backdropFilter: 'blur(4px)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 9999,
          color: '#f3f4f6'
        }}>
          <div style={{
            background: '#1e293b',
            border: '1px solid #475569',
            borderRadius: '8px',
            padding: '20px',
            maxWidth: '400px',
            width: '90%',
            boxShadow: '0 10px 25px -5px rgba(0, 0, 0, 0.3)',
            display: 'flex',
            flexDirection: 'column',
            gap: '12px'
          }}>
            <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: 'bold', color: '#f8fafc' }}>
              動画の読込み方法
            </h3>
            
            <div style={{ fontSize: '0.85rem', color: '#94a3b8', lineHeight: 1.5 }}>
              この動画ファイルをどのように読み込みますか？
            </div>

            <div style={{ fontSize: '0.75rem', color: '#64748b', wordBreak: 'break-all', fontFamily: 'monospace', padding: '6px 8px', background: 'rgba(0,0,0,0.15)', borderRadius: '4px' }}>
              ファイル: {refMediaConfirm.path.split('/').pop()?.split('\\').pop()}
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '8px' }}>
              <button
                onClick={() => {
                  setRefMediaConfirm(null);
                  setStatusText('メディアの読み込みをキャンセルしました');
                }}
                style={{
                  background: 'transparent', color: '#94a3b8', border: '1px solid #475569',
                  borderRadius: '4px', padding: '6px 12px', fontWeight: 500,
                  cursor: 'pointer', transition: 'all 0.15s',
                  fontSize: '0.8rem',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '6px'
                }}
                onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.05)'; e.currentTarget.style.color = '#fff'; }}
                onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = '#94a3b8'; }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
                キャンセル
              </button>

              <button
                onClick={() => {
                  const { path, providedName } = refMediaConfirm;
                  setRefMediaConfirm(null);
                  processSelectedFile(path, true, providedName, true);
                }}
                style={{
                  background: '#374151', color: '#f3f4f6', border: '1px solid #475569',
                  borderRadius: '4px', padding: '6px 12px', fontWeight: 500,
                  cursor: 'pointer', transition: 'background 0.15s',
                  fontSize: '0.8rem',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '6px'
                }}
                onMouseEnter={e => e.currentTarget.style.background = '#4b5563'}
                onMouseLeave={e => e.currentTarget.style.background = '#374151'}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                  <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07" />
                </svg>
                音声のみ
              </button>

              <button
                onClick={() => {
                  const { path, providedName } = refMediaConfirm;
                  setRefMediaConfirm(null);
                  processSelectedFile(path, true, providedName, false);
                }}
                style={{
                  background: '#3b82f6', color: '#fff', border: 'none',
                  borderRadius: '4px', padding: '6px 12px', fontWeight: 500,
                  cursor: 'pointer', transition: 'background 0.15s',
                  fontSize: '0.8rem',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '6px'
                }}
                onMouseEnter={e => e.currentTarget.style.background = '#2563eb'}
                onMouseLeave={e => e.currentTarget.style.background = '#3b82f6'}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M23 7l-7 5 7 5V7z" />
                  <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
                </svg>
                動画 (映像あり)
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}

export default App;
