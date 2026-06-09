import React, { useRef, useEffect } from 'react';
import { WaveformRenderer } from './WaveformRenderer';
import type { TrackData, CutPoint, ExportRange } from './types';

export const TRACK_COLORS = ['#4fb38a', '#5e81ac', '#d08770', '#b48ead', '#ab8f75', '#8fbcbb'];

export function getTrackColor(track: TrackData, allTracks: TrackData[]) {
  if (track.isRef) return TRACK_COLORS[0];
  const nonRefTracks = allTracks.filter(t => !t.isRef);
  const idx = nonRefTracks.findIndex(t => t.id === track.id);
  const safeIdx = idx === -1 ? 0 : idx;
  return TRACK_COLORS[1 + (safeIdx % (TRACK_COLORS.length - 1))];
}

export function formatTimecode(seconds: number, showSign = false): string {
  const isNegative = seconds < 0;
  const absSecs = Math.abs(seconds);
  const h = Math.floor(absSecs / 3600);
  const m = Math.floor((absSecs % 3600) / 60);
  const s = Math.floor(absSecs % 60);
  const ms = Math.floor((absSecs % 1) * 100);
  
  const hStr = h.toString().padStart(2, '0');
  const mStr = m.toString().padStart(2, '0');
  const sStr = s.toString().padStart(2, '0');
  const msStr = ms.toString().padStart(2, '0');
  
  const sign = isNegative ? '-' : (showSign ? '+' : '');
  if (h > 0) {
    return `${sign}${hStr}:${mStr}:${sStr}.${msStr}`;
  } else {
    return `${sign}${mStr}:${sStr}.${msStr}`;
  }
}

interface TimelineProps {
  tracks: TrackData[];
  cuts: CutPoint[];
  pixelsPerSecond: number;
  currentTime: number;
  duration: number;
  onTimeChange: (time: number) => void;
  onCutDelete?: (cutId: string) => void;
  onCutUpdate?: (cutId: string, updates: Partial<CutPoint>) => void;
  onCutAdd?: (cameraId: string, timeSeconds: number) => void;
  onTrackOffsetChange?: (trackId: string, newOffset: number, commit: boolean) => void;
  exportRange?: ExportRange;
  onExportRangeChange?: (updater: React.SetStateAction<ExportRange>, commit?: boolean) => void;
  onAngleChangeRequested?: (cameraId: string) => void;
  playheadScrollThreshold?: number;
  playheadScrollTarget?: number;
  onZoomChange?: (newPixelsPerSecond: number) => void;
  activePreviewCameraId?: string;
  isPlaying?: boolean;
  onPlayingChange?: (playing: boolean) => void;
  projectFps?: number;
  onSyncTrack?: (trackId: string) => void;
  onSyncAllTracks?: () => void;
  onOffsetBadgeMouseDown?: (e: React.MouseEvent, track: TrackData) => void;
  onOffsetBadgeDoubleClick?: (e: React.MouseEvent, track: TrackData) => void;
  onToggleLockTrack?: (trackId: string) => void;
  onTrackNameChange?: (trackId: string, newName: string) => void;
  onTrackDelete?: (trackId: string) => void;
  onTrackReorder?: (draggedId: string, targetId: string) => void;
  isProcessing?: boolean;
}


export function Timeline({
  tracks,
  cuts,
  pixelsPerSecond,
  currentTime,
  duration,
  onTimeChange,
  onCutDelete,
  onCutUpdate,
  onCutAdd,
  onTrackOffsetChange,
  exportRange,
  onExportRangeChange,
  onAngleChangeRequested,
  playheadScrollThreshold = 0.90,
  playheadScrollTarget = 0.40,
  onZoomChange,
  activePreviewCameraId,
  isPlaying,
  onPlayingChange,
  projectFps = 60,
  onSyncTrack,
  onSyncAllTracks,
  onOffsetBadgeMouseDown,
  onOffsetBadgeDoubleClick,
  onToggleLockTrack,
  onTrackNameChange,
  onTrackDelete,
  onTrackReorder,
  isProcessing = false,
}: TimelineProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const leftSidebarRef = useRef<HTMLDivElement>(null);
  const rightContentRef = useRef<HTMLDivElement>(null);
  const playheadLineRef = useRef<HTMLDivElement>(null);
  const isDragging = useRef(false);
  const prevPixelsPerSecondRef = useRef(pixelsPerSecond);
  const lastScrollLeftRef = useRef(0);
  // ホイールズーム用アンカー: 最初のwheelイベントでマウス直下の時刻を確定し、
  // 後続の高速イベントでは時刻を保持したまま useEffect でスクロール先を計算する。
  // useEffect では消さず、wheel停止200ms後のタイムアウトで消すことで
  // 連続render全体でアンカーを一貫して利用できるようにする。
  const zoomMouseAnchorRef = useRef<{ time: number; screenX: number } | null>(null);
  const wheelIdleTimerRef = useRef<number | null>(null);
  const clickTimeoutRef = useRef<number | null>(null);
  const autoScrollTimerRef = useRef<number | null>(null);
  const dragMouseXRef = useRef<number>(0);
  const dragGlobalMouseXRef = useRef<number>(0);
  const [isAltPressed, setIsAltPressed] = React.useState(false);
  const [isRefPinned, setIsRefPinned] = React.useState(true);
  // トラックのドラッグ並べ替え用（カメラトラックのみ対象）
  const dragTrackIdRef = useRef<string | null>(null);
  const [dragOverTrackId, setDragOverTrackId] = React.useState<string | null>(null);
  const [editingTrackId, setEditingTrackId] = React.useState<string | null>(null);
  const [editingName, setEditingName] = React.useState('');

  // Calculate onAirCameraId based on cuts and currentTime
  const sortedCutsForOnAir = [...cuts].sort((a, b) => a.timeSeconds - b.timeSeconds);
  let onAirCameraId = tracks.find(t => t.isRef && !t.isAudioOnly)?.id || tracks.find(t => !t.isAudioOnly)?.id || tracks[0]?.id;
  for (const cut of sortedCutsForOnAir) {
    if (currentTime >= cut.timeSeconds) {
      onAirCameraId = cut.cameraId;
    } else {
      break;
    }
  }

  const onTimeChangeRef = useRef(onTimeChange);
  const onPlayingChangeRef = useRef(onPlayingChange);
  const ppsRef = useRef(pixelsPerSecond);
  const durationRef = useRef(duration);
  const wasPlayingOnDragStart = useRef(false);

  useEffect(() => {
    onTimeChangeRef.current = onTimeChange;
    onPlayingChangeRef.current = onPlayingChange;
    ppsRef.current = pixelsPerSecond;
    durationRef.current = duration;
  }, [onTimeChange, onPlayingChange, pixelsPerSecond, duration]);

  const handleRulerWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    if (!onZoomChange) return;
    e.preventDefault();
    const zoomFactor = e.deltaY < 0 ? 1.15 : 0.85;
    const currentPPS = ppsRef.current;
    const newPPS = Math.max(0.1, Math.min(300, currentPPS * zoomFactor));
    ppsRef.current = newPPS;
    if (containerRef.current) {
      const scrollLeft = containerRef.current.scrollLeft;
      const rect = containerRef.current.getBoundingClientRect();
      const mouseScreenX = e.clientX - rect.left;
      if (zoomMouseAnchorRef.current === null) {
        // 新しいズームシーケンス開始: マウス直下の時刻を確定
        const anchorTime = (mouseScreenX + scrollLeft) / currentPPS;
        zoomMouseAnchorRef.current = { time: anchorTime, screenX: mouseScreenX };
      } else {
        // 連続イベント: 時刻は保持、screenX のみ更新
        zoomMouseAnchorRef.current.screenX = mouseScreenX;
      }
      lastScrollLeftRef.current = scrollLeft;
    }
    // wheel 停止 200ms 後にアンカーをクリア（連続 render 中は保持し続ける）
    if (wheelIdleTimerRef.current !== null) clearTimeout(wheelIdleTimerRef.current);
    wheelIdleTimerRef.current = window.setTimeout(() => {
      zoomMouseAnchorRef.current = null;
      wheelIdleTimerRef.current = null;
    }, 200);
    onZoomChange(newPPS);
  };
  const [contextMenu, setContextMenu] = React.useState<{
    x: number;
    y: number;
    time: number;
    isRulerClick: boolean;
    ribbonSegment?: { startTime: number; endTime: number; cameraId: string; cutId?: string };
    trackId?: string;
  } | null>(null);

  useEffect(() => {
    const handleWindowMouseMove = (e: MouseEvent) => {
      if (!isDragging.current || !containerRef.current || !rightContentRef.current) return;
      
      dragGlobalMouseXRef.current = e.clientX;
      const rect = containerRef.current.getBoundingClientRect();
      dragMouseXRef.current = e.clientX - rect.left;
      
      const rightContentRect = rightContentRef.current.getBoundingClientRect();
      const x = e.clientX - rightContentRect.left;
      if (x >= 0) {
        const time = x / ppsRef.current;
        onTimeChangeRef.current?.(Math.max(0, Math.min(time, durationRef.current)));
      }
    };
    
    const handleWindowMouseUp = (e: MouseEvent) => {
      if (isDragging.current) {
        isDragging.current = false;
        stopAutoScrollLoop();
        
        // 最新のドラッグ位置の時間を親に確実に通知して最終シークを完了させる
        if (rightContentRef.current) {
          const rightContentRect = rightContentRef.current.getBoundingClientRect();
          const x = e.clientX - rightContentRect.left;
          if (x >= 0) {
            const time = x / ppsRef.current;
            onTimeChangeRef.current?.(Math.max(0, Math.min(time, durationRef.current)));
          }
        }

        if (wasPlayingOnDragStart.current) {
          onPlayingChangeRef.current?.(true);
          wasPlayingOnDragStart.current = false;
        }
      }
    };

    window.addEventListener('mousemove', handleWindowMouseMove);
    window.addEventListener('mouseup', handleWindowMouseUp);

    return () => {
      window.removeEventListener('mousemove', handleWindowMouseMove);
      window.removeEventListener('mouseup', handleWindowMouseUp);
      if (clickTimeoutRef.current) window.clearTimeout(clickTimeoutRef.current);
      if (autoScrollTimerRef.current) cancelAnimationFrame(autoScrollTimerRef.current);
    };
  }, []);

  const startAutoScrollLoop = () => {
    if (autoScrollTimerRef.current) return;
    
    const scrollSpeed = 12; // 1フレームあたりの最大スクロール量
    const edgeThreshold = 30; // 画面端とみなすピクセル幅
    
    const updateScroll = () => {
      if (!isDragging.current || !containerRef.current || !rightContentRef.current) {
        stopAutoScrollLoop();
        return;
      }
      
      const container = containerRef.current;
      const viewportWidth = container.clientWidth;
      const scrollLeft = container.scrollLeft;
      const mouseX = dragMouseXRef.current;
      
      let scrollDelta = 0;
      if (mouseX < edgeThreshold) {
        // 左端に近い -> 左にスクロール（端に近いほど加速）
        const ratio = (edgeThreshold - Math.max(0, mouseX)) / edgeThreshold;
        scrollDelta = -scrollSpeed * ratio;
      } else if (mouseX > viewportWidth - edgeThreshold) {
        // 右端に近い -> 右にスクロール（端に近いほど加速）
        const ratio = (Math.min(viewportWidth, mouseX) - (viewportWidth - edgeThreshold)) / edgeThreshold;
        scrollDelta = scrollSpeed * ratio;
      }
      
      if (scrollDelta !== 0) {
        const maxScroll = container.scrollWidth - viewportWidth;
        const newScrollLeft = Math.max(0, Math.min(scrollLeft + scrollDelta, maxScroll));
        
        if (newScrollLeft !== scrollLeft) {
          container.scrollLeft = newScrollLeft;
          // スクロールした分、シーク時間位置も更新
          const rightContentRect = rightContentRef.current.getBoundingClientRect();
          const x = dragGlobalMouseXRef.current - rightContentRect.left;
          const time = x / ppsRef.current;
          onTimeChangeRef.current?.(Math.max(0, Math.min(time, durationRef.current)));
        }
      }
      
      autoScrollTimerRef.current = requestAnimationFrame(updateScroll);
    };
    
    autoScrollTimerRef.current = requestAnimationFrame(updateScroll);
  };
  
  const stopAutoScrollLoop = () => {
    if (autoScrollTimerRef.current) {
      cancelAnimationFrame(autoScrollTimerRef.current);
      autoScrollTimerRef.current = null;
    }
  };


  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Alt') {
        setIsAltPressed(true);
      }
    };
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Alt') {
        setIsAltPressed(false);
      }
    };
    const handleWindowBlur = () => {
      setIsAltPressed(false);
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', handleWindowBlur);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', handleWindowBlur);
    };
  }, []);

  const handleWaveformMouseDown = (e: React.MouseEvent<HTMLDivElement>, track: TrackData) => {
    if (e.button === 2) return; // Right-click bubbles up to container handleContextMenu
    if (e.button !== 0) return; // Only process left-clicks

    if (e.altKey) {
      if (track.isRef || track.isLocked || !onTrackOffsetChange) return;
      
      e.stopPropagation();
      e.preventDefault();
      
      const startX = e.clientX;
      const startOffset = track.offsetSeconds;
      let currentOffset = startOffset;
      
      const originalCursor = document.body.style.cursor;
      document.body.style.cursor = 'ew-resize';

      // ドラッグ対象の波形要素と数値バッジDOMを取得
      const containerDOM = e.currentTarget.querySelector('.waveform-container') as HTMLDivElement;
      const badgeDOM = e.currentTarget.querySelector('.waveform-offset-badge') as HTMLDivElement;
      
      const handleMouseMove = (moveEvent: MouseEvent) => {
        const deltaX = moveEvent.clientX - startX;
        
        // 1) 波形グラフィックをtranslateXでリアルタイムに追従
        if (containerDOM) {
          containerDOM.style.transform = `translateX(${deltaX}px)`;
          containerDOM.style.opacity = '0.7'; // ドラッグ中であることを分かりやすく少し透明に
        }

        const deltaSeconds = deltaX / pixelsPerSecond;
        currentOffset = startOffset + deltaSeconds;

        // 2) 数値バッジの表示内容を直接書き換え
        if (badgeDOM) {
          badgeDOM.style.display = currentOffset === 0 ? 'none' : 'block';
          badgeDOM.innerText = `${currentOffset > 0 ? '+' : ''}${currentOffset.toFixed(3)}s`;
        }

        // 注意: リアルタイム性を最優先にし、再描画の詰まりを防ぐため、
        // ドラッグ中の React ステート更新 (onTrackOffsetChange(..., false)) は意図的にスキップします。
      };
      
      const handleMouseUp = () => {
        document.body.style.cursor = originalCursor;
        window.removeEventListener('mousemove', handleMouseMove);
        window.removeEventListener('mouseup', handleMouseUp);
        
        // ドラッグ終了時にスタイルをリセット (直後に正規のReact再描画で正しい位置に配置される)
        if (containerDOM) {
          containerDOM.style.transform = '';
          containerDOM.style.opacity = '';
        }
        if (badgeDOM) {
          badgeDOM.style.display = currentOffset === 0 ? 'none' : 'block';
        }

        // 最終位置でオフセット確定を通知
        onTrackOffsetChange(track.id, currentOffset, true);
      };
      
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
      return;
    }

    // Double click on Waveform to add a cut (Single click preview switch removed)
    if (track.isAudioOnly) return;

    const rect = e.currentTarget.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const clickTime = Math.max(0, Math.min(clickX / pixelsPerSecond, duration));

    if (e.detail === 2) {
      onCutAdd?.(track.id, clickTime);
    }
  };

  useEffect(() => {
    const closeMenu = () => {
      setContextMenu(null);
    };
    window.addEventListener('click', closeMenu);
    return () => window.removeEventListener('click', closeMenu);
  }, []);

  const handleContextMenu = (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (!containerRef.current || !rightContentRef.current) return;

    const rect = containerRef.current.getBoundingClientRect();
    
    const clickY = e.clientY - rect.top;
    const isRulerClick = clickY < 48;
    
    let clickTime = currentTime;
    if (isRulerClick) {
      const rightContentRect = rightContentRef.current.getBoundingClientRect();
      const x = e.clientX - rightContentRect.left;
      if (x >= 0) {
        clickTime = Math.max(0, Math.min(x / pixelsPerSecond, duration));
        onTimeChange(clickTime);
      }
    }
    
    const cameraCount = tracks.filter(t => !t.isAudioOnly).length;
    const nearbyCut = cuts.find(c => Math.abs(c.timeSeconds - clickTime) < 0.5);
    const menuWidth = 150;
    const menuHeight = 90 + cameraCount * 30 + (exportRange?.useRange ? 30 : 0) + (nearbyCut ? 35 : 0);

    let spawnX = e.clientX;
    let spawnY = e.clientY;
    
    if (isRulerClick) {
      // Shift menu slightly horizontally so it doesn't overlap the playhead
      if (e.clientX + 8 + menuWidth > window.innerWidth) {
        spawnX = Math.max(10, e.clientX - menuWidth - 8);
      } else {
        spawnX = e.clientX + 8;
      }
    } else {
      if (e.clientX + menuWidth > window.innerWidth) {
        spawnX = window.innerWidth - menuWidth - 10;
      }
    }
    if (e.clientY + menuHeight > window.innerHeight) {
      spawnY = e.clientY - menuHeight;
      if (spawnY < 10) spawnY = 10;
    }
    
    setContextMenu({
      x: spawnX,
      y: spawnY,
      time: clickTime,
      isRulerClick
    });
  };

  const handleAddCutAtClick = (cameraId: string) => {
    if (contextMenu && onCutAdd) {
      onCutAdd(cameraId, contextMenu.time);
      setContextMenu(null);
    }
  };

  const handleSetExportStart = () => {
    if (contextMenu && onExportRangeChange) {
      onExportRangeChange(prev => ({
        ...prev,
        start: contextMenu!.time,
        useRange: true
      }));
      setContextMenu(null);
    }
  };

  const handleSetExportEnd = () => {
    if (contextMenu && onExportRangeChange) {
      onExportRangeChange(prev => ({
        ...prev,
        end: contextMenu!.time,
        useRange: true
      }));
      setContextMenu(null);
    }
  };

  const handleClearExportRange = () => {
    if (onExportRangeChange) {
      onExportRangeChange(prev => ({
        ...prev,
        useRange: false
      }));
      setContextMenu(null);
    }
  };

  const getNearbyCut = () => {
    if (!contextMenu) return null;
    return cuts.find(c => Math.abs(c.timeSeconds - contextMenu.time) < 0.5);
  };

  // リボンセグメントのカメラを変更する
  const handleChangeRibbonCamera = (newCameraId: string) => {
    if (!contextMenu?.ribbonSegment) return;
    const seg = contextMenu.ribbonSegment;

    if (seg.cutId) {
      // このセグメントを開始したカットポイントのcameraIdを変更
      onCutUpdate?.(seg.cutId, { cameraId: newCameraId });
    } else {
      // 先頭セグメント（カットポイントなし）→ 先頭にカットを追加し、次のセグメント先頭も考慮
      // 先頭セグメントは時間0から始まるので、実質「デフォルトカメラ」の変更
      // 方法: 時間0に新しいカットを追加し、その後のセグメントも維持する
      // ただし既存の最初のカットより前 (t=0付近) にカットを追加するのは意味がないため
      // 「新しいカットをseg.startTime=0に追加」は行わず、
      // 代わりにseg.endTimeの直前にカットを追加して元のカメラへ戻す方式をとる。
      // → 簡単な実装: endTimeにカットポイントを追加して「その後は元のカメラに戻す」
      //   + 0秒時点では新しいカメラのカットを追加
      // シンプルにするため: onCutAddを使って0秒に新カメラのカットを追加する
      onCutAdd?.(newCameraId, 0);
    }
    setContextMenu(null);
  };

  const handleExportLimitDragMouseDown = (e: React.MouseEvent, type: 'start' | 'end') => {
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
      const fps = projectFps ?? 60;
      const frameDuration = 1 / fps;
      const rawVal = Math.round((initialVal + deltaSeconds) / frameDuration) * frameDuration;

      if (type === 'start') {
        const minVal = 0;
        const maxVal = (exportRange?.end || duration) - 0.1;
        newVal = Math.max(minVal, Math.min(rawVal, maxVal));
        onExportRangeChange?.(prev => ({ ...prev, start: newVal }), false);
      } else {
        const minVal = (exportRange?.start || 0) + 0.1;
        const maxVal = duration;
        newVal = Math.max(minVal, Math.min(rawVal, maxVal));
        onExportRangeChange?.(prev => ({ ...prev, end: newVal }), false);
      }
    };

    const handleMouseUp = () => {
      document.body.style.cursor = originalCursor;
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      // ドラッグ確定時に最終値を一度だけ履歴へ積む
      onExportRangeChange?.(prev => prev, true);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  };

  const calculateAngleIntervals = () => {
    const intervals: { startTime: number; endTime: number; cameraId: string }[] = [];
    if (tracks.length === 0) return intervals;

    const sortedCuts = [...cuts].sort((a, b) => a.timeSeconds - b.timeSeconds);
    const defaultCameraId = tracks.find(t => t.isRef && !t.isAudioOnly)?.id || tracks.find(t => !t.isAudioOnly)?.id || tracks[0].id;
    
    let lastTime = 0;
    let lastCameraId = defaultCameraId;

    for (const cut of sortedCuts) {
      if (cut.timeSeconds > lastTime) {
        intervals.push({
          startTime: lastTime,
          endTime: Math.min(cut.timeSeconds, duration),
          cameraId: lastCameraId
        });
      }
      lastTime = cut.timeSeconds;
      lastCameraId = cut.cameraId;
    }

    if (lastTime < duration) {
      intervals.push({
        startTime: lastTime,
        endTime: duration,
        cameraId: lastCameraId
      });
    }

    return intervals;
  };



  const renderRulerTicks = () => {
    const ticks = [];
    // pixelsPerSecond (ズーム値) に応じて目盛りの間隔を動的に調整
    const getStepSeconds = (pps: number) => {
      const minSpacing = 55; // 目盛り線間の最小ピクセル幅（表示頻度を上げるために小さく設定）
      const targetStep = minSpacing / pps;
      const standardIntervals = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
      for (const interval of standardIntervals) {
        if (interval >= targetStep) return interval;
      }
      return 600;
    };
    const stepSeconds = getStepSeconds(pixelsPerSecond);
    
    // 中間の目盛り（時間表示の間）の間隔を計算
    let minorStep = stepSeconds / 2;
    if (stepSeconds === 5) minorStep = 1;
    if (stepSeconds === 10) minorStep = 2;
    if (stepSeconds === 15) minorStep = 3;
    if (stepSeconds >= 30) minorStep = stepSeconds / 5;
    
    for (let sec = 0; sec <= duration; sec += minorStep) {
      const isMajor = Math.abs(sec % stepSeconds) < 0.01 || Math.abs((sec % stepSeconds) - stepSeconds) < 0.01;
      const left = sec * pixelsPerSecond;
      
      if (isMajor) {
        const mins = Math.floor(sec / 60);
        const secs = Math.floor(sec % 60);
        const timeStr = `${mins}:${secs.toString().padStart(2, '0')}`;
        
        ticks.push(
          <div 
            key={`major-${sec}`} 
            style={{
              position: 'absolute',
              left: `${left}px`,
              top: 0,
              bottom: 0,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'space-between',
              height: '100%',
              pointerEvents: 'none',
              width: '1px'
            }}
          >
            {/* 主要な目盛り線 (長め) */}
            <div style={{ width: '1px', height: '8px', background: 'rgba(255,255,255,0.45)' }} />
            {/* 時間テキスト */}
            <span style={{ fontSize: '0.6rem', color: '#94a3b8', fontFamily: 'monospace', lineHeight: 1, whiteSpace: 'nowrap' }}>
              {timeStr}
            </span>
          </div>
        );
      } else {
        // 中間の目盛り線 (短めでテキストなし)
        ticks.push(
          <div 
            key={`minor-${sec}`} 
            style={{
              position: 'absolute',
              left: `${left}px`,
              top: 0,
              height: '4px',
              width: '1px',
              background: 'rgba(255,255,255,0.2)',
              pointerEvents: 'none'
            }}
          />
        );
      }
    }
    return ticks;
  };

  const handleTimelineMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;

    if (!containerRef.current || !rightContentRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();

    // 縦スクロールによるズレを防ぐため、Rulerヘッダーのrectを基準にY軸位置を計算する
    let clickY = e.clientY - rect.top;
    if (headerRef.current) {
      const headerRect = headerRef.current.getBoundingClientRect();
      clickY = e.clientY - headerRect.top;
    }

    if (clickY < 52) { // Header (Ruler 24px + Ribbon 28px = 52px) 内でのみシーク開始
      isDragging.current = true;
      wasPlayingOnDragStart.current = !!isPlaying;
      
      if (isPlaying) {
        onPlayingChangeRef.current?.(false);
      }

      dragGlobalMouseXRef.current = e.clientX;
      dragMouseXRef.current = e.clientX - rect.left;
      
      const rightContentRect = rightContentRef.current.getBoundingClientRect();
      const x = e.clientX - rightContentRect.left;
      
      if (x >= 0) {
        const time = x / pixelsPerSecond;
        onTimeChange(Math.max(0, Math.min(time, duration)));
      }
      
      startAutoScrollLoop();
    }
  };

  // プレイヘッドを画面の左寄りに保つ（再生中）
  useEffect(() => {
    if (containerRef.current && !isDragging.current) {
      const playheadX = currentTime * pixelsPerSecond;
      const containerWidth = containerRef.current.clientWidth;
      const scrollLeft = containerRef.current.scrollLeft;
      
      const sidebarWidth = 180;
      const visibleTimelineWidth = Math.max(0, containerWidth - sidebarWidth);
      
      // プレイヘッドが画面の右端付近（設定したしきい値%以上）に到達したらスクロールして目標位置に配置する
      if (playheadX > scrollLeft + visibleTimelineWidth * playheadScrollThreshold) {
        containerRef.current.scrollTo({ left: Math.max(0, playheadX - visibleTimelineWidth * playheadScrollTarget), behavior: 'auto' });
      } else if (playheadX < scrollLeft) {
        // プレイヘッドが画面左端より左に外れた場合（カットリストクリックなどで後方ジャンプ時）: 同じ目標位置に収める
        containerRef.current.scrollTo({ left: Math.max(0, playheadX - visibleTimelineWidth * playheadScrollTarget), behavior: 'auto' });
      }
    }
  }, [currentTime, pixelsPerSecond, playheadScrollThreshold, playheadScrollTarget]);

  // ズームイン/ズームアウト時のスクロール中心位置維持
  useEffect(() => {
    const oldPPS = prevPixelsPerSecondRef.current;
    const newPPS = pixelsPerSecond;

    if (oldPPS !== newPPS && containerRef.current) {
      const container = containerRef.current;

      if (zoomMouseAnchorRef.current !== null) {
        // ルーラーホイールズーム: アンカー時刻を基準に現在の PPS でスクロール先を計算
        // アンカーは wheel 停止タイムアウトで消えるのでここでは消さない
        const { time, screenX } = zoomMouseAnchorRef.current;
        container.scrollLeft = Math.max(0, time * newPPS - screenX);
      } else {
        // スライダー/ボタンズーム: プレイヘッド基準 or 画面中央基準
        const viewportWidth = container.clientWidth;
        const sidebarWidth = 180;
        const visibleTimelineWidth = Math.max(0, viewportWidth - sidebarWidth);
        const oldScrollLeft = lastScrollLeftRef.current;

        const playheadX_old = currentTime * oldPPS;
        const isPlayheadVisible = playheadX_old >= oldScrollLeft && playheadX_old <= oldScrollLeft + visibleTimelineWidth;

        let newScrollLeft: number;
        if (isPlayheadVisible) {
          const offset = playheadX_old - oldScrollLeft;
          newScrollLeft = currentTime * newPPS - offset;
        } else {
          const centerTime = Math.max(0, (oldScrollLeft + visibleTimelineWidth / 2) / oldPPS);
          newScrollLeft = centerTime * newPPS - visibleTimelineWidth / 2;
        }
        container.scrollLeft = Math.max(0, newScrollLeft);
      }

      lastScrollLeftRef.current = container.scrollLeft;
    }
    prevPixelsPerSecondRef.current = pixelsPerSecond;
  }, [pixelsPerSecond, currentTime]);

  const timelineWidth = Math.max(1000, duration * pixelsPerSecond + 1200);

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const scrollLeft = e.currentTarget.scrollLeft;
    const scrollTop = e.currentTarget.scrollTop;
    lastScrollLeftRef.current = scrollLeft;
    if (leftSidebarRef.current) {
      leftSidebarRef.current.scrollTop = scrollTop;
    }
    if (playheadLineRef.current) {
      playheadLineRef.current.style.left = `${currentTime * pixelsPerSecond - scrollLeft}px`;
    }
  };

  return (
    <div
      className="timeline-outer-container"
      style={{ display: 'flex', overflow: 'hidden', position: 'relative', background: 'rgba(0,0,0,0.2)', borderRadius: '8px', height: '100%', boxSizing: 'border-box' }}
    >
      {/* 1. Left Sidebar (Fixed 180px Wide Labels, Outside Scroll Container) */}
      <div
        ref={leftSidebarRef}
        className="timeline-left-sidebar"
        onWheel={(e) => {
          if (containerRef.current) {
            containerRef.current.scrollTop += e.deltaY;
          }
        }}
        style={{
          width: '180px',
          minWidth: '180px',
          maxWidth: '180px',
          flexShrink: 0, 
          display: 'flex', 
          flexDirection: 'column', 
          boxSizing: 'border-box',
          backgroundColor: '#111827',
          borderRight: '1px solid #1e293b',
          position: 'relative',
          zIndex: 10,
          overflowY: 'hidden',
          height: '100%'
        }}
      >
          {/* Zoom Control Panel (高さ 46px 固定, 2段縦並び flex) */}
          {onZoomChange && (
            <div 
              style={{
                position: 'sticky',
                top: 0,
                zIndex: 120,
                width: '180px',
                height: '52px',
                backgroundColor: '#1e293b',
                borderBottom: '1px solid #334155',
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'center',
                padding: '0 12px',
                boxSizing: 'border-box',
                cursor: 'default',
                flexShrink: 0
              }}
              onClick={e => e.stopPropagation()}
              onMouseDown={e => e.stopPropagation()}
            >
              {/* 上段: ズームアイコン + 中央に Sync All */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px', width: '100%' }}>
                {/* Zoom Out Icon */}
                <div
                  style={{ display: 'flex', alignItems: 'center', cursor: 'pointer', padding: '2px' }}
                  onClick={() => {
                    if (containerRef.current) lastScrollLeftRef.current = containerRef.current.scrollLeft;
                    onZoomChange(Math.max(0.1, pixelsPerSecond / 1.3));
                  }}
                  title="ズームアウト"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="11" cy="11" r="8"></circle>
                    <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
                    <line x1="8" y1="11" x2="14" y2="11"></line>
                  </svg>
                </div>

                {/* Zoom In Icon */}
                <div
                  style={{ display: 'flex', alignItems: 'center', cursor: 'pointer', padding: '2px' }}
                  onClick={() => {
                    if (containerRef.current) lastScrollLeftRef.current = containerRef.current.scrollLeft;
                    onZoomChange(Math.min(200, pixelsPerSecond * 1.3));
                  }}
                  title="ズームイン"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="11" cy="11" r="8"></circle>
                    <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
                    <line x1="11" y1="8" x2="11" y2="14"></line>
                    <line x1="8" y1="11" x2="14" y2="11"></line>
                  </svg>
                </div>
              </div>

              {/* 下段: スライダー */}
              <input 
                type="range" 
                min="0" max="100" step="0.1"
                value={((Math.log(pixelsPerSecond) - Math.log(0.1)) / (Math.log(200) - Math.log(0.1))) * 100} 
                onChange={e => {
                  const val = Number(e.target.value);
                  const logVal = Math.log(0.1) + (val / 100) * (Math.log(200) - Math.log(0.1));
                  if (containerRef.current) {
                    lastScrollLeftRef.current = containerRef.current.scrollLeft;
                  }
                  onZoomChange(Math.exp(logVal));
                }}
                onDoubleClick={() => {
                  if (containerRef.current) {
                    lastScrollLeftRef.current = containerRef.current.scrollLeft;
                  }
                  onZoomChange(20);
                }}
                onClick={e => {
                  if (e.ctrlKey) {
                    if (containerRef.current) {
                      lastScrollLeftRef.current = containerRef.current.scrollLeft;
                    }
                    onZoomChange(20);
                  }
                }}
                style={{ width: '100%', height: '4px', margin: 0, cursor: 'pointer', accentColor: '#3b82f6' }}
              />
            </div>
          )}

          {/* Track Labels in Left Sidebar */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0', marginTop: '8px', flexShrink: 0 }}>
            {tracks.map((track) => {
              const trackColor = getTrackColor(track, tracks);
              const isPinnedRow = track.isRef && isRefPinned;

              const isDragOver = dragOverTrackId === track.id && !track.isRef;

              return (
                <div
                  key={track.id}
                  className={`track-sidebar-row ${isPinnedRow ? 'pinned' : ''}`}
                  onDragOver={(e) => {
                    if (dragTrackIdRef.current && !track.isRef && dragTrackIdRef.current !== track.id) {
                      e.preventDefault();
                      if (dragOverTrackId !== track.id) setDragOverTrackId(track.id);
                    }
                  }}
                  onDrop={(e) => {
                    if (dragTrackIdRef.current && !track.isRef && dragTrackIdRef.current !== track.id) {
                      e.preventDefault();
                      onTrackReorder?.(dragTrackIdRef.current, track.id);
                    }
                    dragTrackIdRef.current = null;
                    setDragOverTrackId(null);
                  }}
                  style={{
                    display: 'flex',
                    alignItems: 'stretch',
                    height: '63px',
                    position: isPinnedRow ? 'sticky' : 'relative',
                    top: isPinnedRow ? '52px' : 'auto',
                    zIndex: isPinnedRow ? 120 : 100,
                    backgroundColor: isPinnedRow ? '#1e293b' : '#111827',
                    borderBottom: '1px solid rgba(255,255,255,0.05)',
                    borderTop: isDragOver ? '2px solid #3b82f6' : '1px solid transparent',
                    boxShadow: isPinnedRow ? '0 4px 6px -1px rgba(0,0,0,0.3)' : 'none',
                    transition: 'background-color 0.2s',
                    boxSizing: 'border-box'
                  }}
                >
                  {/* トラックラベル & オンエア領域 (横 180px) */}
                  <div
                    className={`track-label-cell ${track.isRef ? 'ref' : 'target'}`}
                    style={{
                      width: '180px',
                      boxSizing: 'border-box',
                      flexShrink: 0,
                      padding: '6px 10px',
                      backgroundColor: track.id === activePreviewCameraId ? 'rgba(255, 255, 255, 0.06)' : (isPinnedRow ? '#1e293b' : '#111827'),
                      borderRight: `3px solid ${trackColor}`,
                      borderBottom: '1px solid rgba(255,255,255,0.05)',
                      boxShadow: track.id === activePreviewCameraId
                        ? `inset 4px 0 0 0 ${trackColor}, inset 0 0 0 2px ${trackColor}, 0 0 10px ${trackColor}33`
                        : 'none',
                      display: 'flex',
                      flexDirection: 'column',
                      justifyContent: 'center',
                      gap: '6px',
                      userSelect: 'none',
                      cursor: track.isAudioOnly ? 'default' : (track.id === activePreviewCameraId ? 'default' : 'pointer'),
                      transition: 'all 0.2s ease',
                      height: '100%'
                    }}
                    onClick={() => {
                      if (!track.isAudioOnly && track.id !== activePreviewCameraId) {
                        onAngleChangeRequested?.(track.id);
                      }
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      const menuHeight = track.isRef ? 200 : 280;
                      let spawnY = e.clientY;
                      if (spawnY + menuHeight > window.innerHeight) {
                        spawnY = Math.max(10, window.innerHeight - menuHeight - 10);
                      }
                      setContextMenu({ x: e.clientX, y: spawnY, time: currentTime, isRulerClick: false, trackId: track.id });
                    }}
                  >
                    {/* 上段: (ドラッグハンドル) + オンエアドット + ピンボタン + トラック名 */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '4px', overflow: 'hidden' }}>
                      {!track.isRef && (
                        <span
                          draggable
                          onDragStart={(e) => {
                            dragTrackIdRef.current = track.id;
                            e.dataTransfer.effectAllowed = 'move';
                            try { e.dataTransfer.setData('text/plain', track.id); } catch { /* noop */ }
                          }}
                          onDragEnd={() => { dragTrackIdRef.current = null; setDragOverTrackId(null); }}
                          onClick={(e) => e.stopPropagation()}
                          onMouseDown={(e) => e.stopPropagation()}
                          onDoubleClick={(e) => e.stopPropagation()}
                          title="ドラッグでトラックを並べ替え"
                          style={{ flexShrink: 0, cursor: 'grab', color: '#64748b', display: 'flex', alignItems: 'center', lineHeight: 0 }}
                        >
                          <svg width="8" height="14" viewBox="0 0 8 14" fill="currentColor" aria-hidden="true">
                            <circle cx="2" cy="3" r="1.1" /><circle cx="6" cy="3" r="1.1" />
                            <circle cx="2" cy="7" r="1.1" /><circle cx="6" cy="7" r="1.1" />
                            <circle cx="2" cy="11" r="1.1" /><circle cx="6" cy="11" r="1.1" />
                          </svg>
                        </span>
                      )}
                      <div style={{ width: '9px', height: '9px', flexShrink: 0 }}>
                        {track.id === onAirCameraId ? (
                          <div
                            className="status-dot processing"
                            style={{ width: '9px', height: '9px', borderRadius: '50%', backgroundColor: '#ef4444', boxShadow: '0 0 6px #ef4444' }}
                            title="現在オンエア中"
                          />
                        ) : null}
                      </div>

                      {track.isRef && (
                        <button
                          onClick={(e) => { e.stopPropagation(); setIsRefPinned(prev => !prev); }}
                          style={{
                            background: 'none',
                            border: 'none',
                            color: isRefPinned ? '#3b82f6' : '#475569',
                            cursor: 'pointer',
                            padding: '2px',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            borderRadius: '4px',
                            backgroundColor: isRefPinned ? 'rgba(59, 130, 246, 0.15)' : 'transparent',
                            flexShrink: 0,
                            transition: 'all 0.15s ease'
                          }}
                          title={isRefPinned ? "ピン留め解除" : "上部にピン留め"}
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24" fill={isRefPinned ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <line x1="12" y1="17" x2="12" y2="22" />
                            <path d="M5 17h14v-1.76a2 2 0 0 0-.44-1.24l-2.33-2.91A8 8 0 0 1 15 6V3H9v3a8 8 0 0 1-1.23 5.09l-2.33 2.91a2 2 0 0 0-.44 1.24V17z" />
                          </svg>
                        </button>
                      )}

                      {editingTrackId === track.id ? (
                        <input
                          autoFocus
                          value={editingName}
                          onChange={e => setEditingName(e.target.value)}
                          onBlur={() => {
                            const trimmed = editingName.trim();
                            if (trimmed) onTrackNameChange?.(track.id, trimmed);
                            setEditingTrackId(null);
                          }}
                          onKeyDown={e => {
                            if (e.key === 'Enter') { (e.target as HTMLInputElement).blur(); }
                            if (e.key === 'Escape') { setEditingTrackId(null); }
                            e.stopPropagation();
                          }}
                          onClick={e => e.stopPropagation()}
                          onMouseDown={e => e.stopPropagation()}
                          style={{
                            flex: 1, minWidth: 0, fontSize: '0.85rem', fontWeight: 'bold',
                            background: 'rgba(59,130,246,0.15)', border: '1px solid #3b82f6',
                            borderRadius: '3px', color: '#e2e8f0', padding: '0 4px',
                            outline: 'none', height: '22px'
                          }}
                        />
                      ) : (
                        <span
                          style={{ fontSize: '0.85rem', fontWeight: 'bold', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}
                          onDoubleClick={e => {
                            e.stopPropagation();
                            setEditingTrackId(track.id);
                            setEditingName(track.name);
                          }}
                          title="ダブルクリックで名前を編集"
                        >
                          {track.name}
                        </span>
                      )}

                      {track.isRef && (
                        <span style={{ fontSize: '0.7rem', fontWeight: 700, color: '#052e16', background: '#4ade80', border: '1px solid #4ade80', padding: '2px 5px', borderRadius: '4px', fontFamily: 'monospace', flexShrink: 0 }}>
                          REF
                        </span>
                      )}

                      {track.audioOffsetSeconds && track.audioOffsetSeconds !== 0 ? (
                        <div
                          style={{ fontSize: '0.65rem', color: '#fbbf24', background: 'rgba(251, 191, 36, 0.12)', border: '1px solid rgba(251, 191, 36, 0.3)', borderRadius: '3px', padding: '2px 4px', fontWeight: 'bold', flexShrink: 0 }}
                          title={`音声ディレイ: ${(track.audioOffsetSeconds * 1000).toFixed(0)}ms`}
                        >
                          {track.audioOffsetSeconds > 0 ? '+' : ''}{(track.audioOffsetSeconds * 1000).toFixed(0)}ms
                        </div>
                      ) : null}
                    </div>

                    {/* 下段: Sync All (refトラックのみ) */}
                    {track.isRef && onSyncAllTracks && tracks.length > 1 && (
                      <div style={{ display: 'flex', alignItems: 'center' }}>
                        <button
                          className="btn btn-sync"
                          onClick={(e) => { e.stopPropagation(); onSyncAllTracks(); }}
                          disabled={isProcessing || tracks.filter(t => !t.isRef).every(t => (t as any).lastAutoSyncedOffset !== undefined || t.isLocked)}
                          style={{ height: '20px', boxSizing: 'border-box', lineHeight: '20px', padding: '0 5px', fontSize: '0.72rem', flexShrink: 0 }}
                        >
                          Sync All
                        </button>
                      </div>
                    )}

                    {/* 下段: Auto Sync + オフセットバッジ + ロック (非refトラックのみ) */}
                    {!track.isRef && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                        {tracks.some(t => t.isRef) && onSyncTrack && (
                          <button
                            className="btn btn-sync"
                            onClick={(e) => { e.stopPropagation(); onSyncTrack(track.id); }}
                            disabled={isProcessing || (track as any).lastAutoSyncedOffset !== undefined || track.isLocked}
                            style={{ height: '20px', boxSizing: 'border-box', lineHeight: '20px', padding: '0 5px', fontSize: '0.72rem', flexShrink: 0 }}
                          >
                            {(track as any).lastAutoSyncedOffset !== undefined ? (
                              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '2px' }}>
                                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                                Synced
                              </span>
                            ) : 'Auto Sync'}
                          </button>
                        )}

                        <span
                          className="offset-scrub-badge"
                          onMouseDown={(e) => onOffsetBadgeMouseDown?.(e, track)}
                          onDoubleClick={(e) => onOffsetBadgeDoubleClick?.(e, track)}
                          onClick={e => e.stopPropagation()}
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            height: '20px',
                            boxSizing: 'border-box',
                            lineHeight: 1,
                            fontSize: '0.72rem',
                            color: track.isLocked ? '#94a3b8' : '#60a5fa',
                            background: track.isLocked ? 'rgba(255,255,255,0.05)' : 'rgba(59, 130, 246, 0.1)',
                            border: track.isLocked ? '1px solid rgba(255,255,255,0.1)' : '1px solid rgba(59, 130, 246, 0.3)',
                            padding: '0 5px',
                            borderRadius: '4px',
                            fontFamily: 'monospace',
                            cursor: track.isLocked ? 'not-allowed' : 'ew-resize',
                            userSelect: 'none',
                            flexShrink: 0,
                            transition: 'all 0.15s ease'
                          }}
                          title={track.isLocked ? "ロックされています" : "ドラッグ: 微調整 / ダブルクリック: リセット"}
                        >
                          {track.offsetSeconds > 0 ? '+' : ''}{track.offsetSeconds.toFixed(3)}s
                        </span>

                        {onToggleLockTrack && (
                          <button
                            className={`btn btn-lock ${track.isLocked ? 'locked' : ''}`}
                            onClick={(e) => { e.stopPropagation(); onToggleLockTrack(track.id); }}
                            style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '20px', height: '20px', padding: '0', flexShrink: 0 }}
                            title={track.isLocked ? "クリックしてロック解除" : "クリックしてオフセットをロック"}
                          >
                            {track.isLocked ? (
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                              </svg>
                            ) : (
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                                <path d="M7 11V7a5 5 0 0 1 9.9-1" />
                              </svg>
                            )}
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          {/* 右側コンテナの水平スクロールバー(高さ8px、App.css で固定)分の余白を補う。
              これがないと右側の clientHeight だけが小さくなり、最下部までスクロールした際に
              左ラベルと波形の位置がずれてしまう。 */}
          <div style={{ height: '8px', flexShrink: 0 }} />
        </div>

        {/* Unified Horizontal and Vertical Scroll Container for Right Content */}
        <div 
          className="timeline-right-scroll"
          ref={containerRef}
          style={{ 
            flex: 1, 
            overflowX: 'auto', 
            overflowY: 'auto', 
            position: 'relative',
            boxSizing: 'border-box',
            display: 'flex'
          }}
          onMouseDown={handleTimelineMouseDown}
          onScroll={handleScroll}
          onContextMenu={handleContextMenu}
        >
          {/* 2. Waveforms & Ruler Right Content (Scrolls Horizontally) */}
          <div 
            className="timeline-right-content" 
          ref={rightContentRef}
          style={{
            width: `${timelineWidth}px`,
            minHeight: '100%',
            alignSelf: 'flex-start',
            position: 'relative',
            display: 'flex',
            flexDirection: 'column',
            boxSizing: 'border-box',
            flexShrink: 0
          }}
        >
          {/* Timeline Header (Ruler + Ribbon) */}
          <div 
            ref={headerRef}
            style={{
              position: 'sticky',
              top: 0,
              zIndex: 90,
              display: 'flex',
              height: '52px',
              width: `${timelineWidth}px`,
              backgroundColor: '#111827',
              boxSizing: 'border-box'
            }}
          >
            {/* Right side Ruler + Ribbon Area */}
            <div style={{ width: `${timelineWidth}px`, flexShrink: 0, flexGrow: 0, position: 'relative', display: 'flex', flexDirection: 'column', height: '52px', marginTop: 0 }}>
              {/* Time Ruler (時間ルーラー) */}
              <div 
                onWheel={handleRulerWheel}
                style={{
                  height: '24px',
                  width: '100%',
                  backgroundColor: '#111827',
                  borderBottom: '1px solid rgba(255,255,255,0.08)',
                  cursor: 'default',
                  userSelect: 'none',
                  boxSizing: 'border-box',
                  display: 'flex',
                  alignItems: 'center'
                }}
              >
                <div style={{ position: 'relative', width: '100%', height: '100%' }}>
                  {renderRulerTicks()}
                </div>
              </div>

              {/* Ribbon Area */}
              <div
                onWheel={handleRulerWheel}
                style={{
                  height: '28px',
                  width: '100%',
                  backgroundColor: '#111827',
                  borderBottom: '1px solid #1e293b',
                  display: 'flex',
                  alignItems: 'center',
                  boxSizing: 'border-box',
                  cursor: 'default'
                }}
              >
                <div style={{
                  position: 'relative',
                  height: '20px',
                  width: '100%',
                  background: 'rgba(0,0,0,0.4)',
                  borderRadius: '4px',
                  overflow: 'hidden',
                  display: 'flex'
                }}>
                  {calculateAngleIntervals().map((interval, index) => {
                    const track = tracks.find(t => t.id === interval.cameraId);
                    const trackColor = track ? getTrackColor(track, tracks) : '#64748b';
                    const width = (interval.endTime - interval.startTime) * pixelsPerSecond;
                    const left = interval.startTime * pixelsPerSecond;
                    const segCut = cuts.find(c => Math.abs(c.timeSeconds - interval.startTime) < 0.01);
                    return (
                      <div
                        key={index}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          const menuWidth = 200;
                          const menuHeight = 60 + tracks.filter(t => !t.isAudioOnly).length * 32;
                          let spawnX = e.clientX;
                          let spawnY = e.clientY;
                          if (spawnX + menuWidth > window.innerWidth) spawnX = window.innerWidth - menuWidth - 10;
                          if (spawnY + menuHeight > window.innerHeight) { spawnY = spawnY - menuHeight; if (spawnY < 10) spawnY = 10; }
                          setContextMenu({
                            x: spawnX,
                            y: spawnY,
                            time: (left + width / 2) / pixelsPerSecond,
                            isRulerClick: false,
                            ribbonSegment: { startTime: interval.startTime, endTime: interval.endTime, cameraId: interval.cameraId, cutId: segCut?.id }
                          });
                        }}
                        style={{
                          position: 'absolute',
                          left: `${left}px`,
                          width: `${width}px`,
                          height: '100%',
                          background: trackColor,
                          borderRight: '1px solid rgba(0,0,0,0.3)',
                          display: 'flex',
                          alignItems: 'center',
                          paddingLeft: '6px',
                          boxSizing: 'border-box',
                          color: '#fff',
                          fontSize: '0.7rem',
                          fontWeight: 'bold',
                          textShadow: '0 1px 2px rgba(0,0,0,0.8)',
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          cursor: 'pointer',
                        }}
                        title={`右クリックでカメラ変更 | ${track?.name || 'Unknown'}: ${formatTimecode(interval.startTime)} - ${formatTimecode(interval.endTime)}`}
                      >
                        {track?.name || 'Unknown'}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>



        {/* Export Range Overlay (Split into clipped mask/lines and unclipped popovers) */}
        {exportRange?.useRange && (
          <>
            {/* 1. Mask & Boundary Lines (Clipped to waveform area) */}
            <div style={{
              position: 'absolute',
              top: '0px',
              left: 0,
              width: `${timelineWidth}px`,
              bottom: '8px',
              pointerEvents: 'none',
              overflow: 'hidden',
              zIndex: 91
            }}>
              {/* Left mask */}
              {exportRange.start > 0 && (
                <div style={{
                  position: 'absolute',
                  left: 0,
                  top: 0,
                  bottom: 0,
                  width: `${exportRange.start * pixelsPerSecond}px`,
                  background: 'rgba(0, 0, 0, 0.4)',
                  borderRight: '1.5px solid #3b82f6',
                  boxSizing: 'border-box',
                  pointerEvents: 'none'
                }}>
                  <div 
                    className="export-marker-in"
                    onMouseDown={(e) => handleExportLimitDragMouseDown(e, 'start')}
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                    }}
                    title="ドラッグして範囲微調整"
                  />
                </div>
              )}
              {/* Right mask */}
              {exportRange.end < duration && (
                <div style={{
                  position: 'absolute',
                  left: `${exportRange.end * pixelsPerSecond}px`,
                  top: 0,
                  bottom: 0,
                  width: `${(duration - exportRange.end) * pixelsPerSecond}px`,
                  background: 'rgba(0, 0, 0, 0.4)',
                  borderLeft: '1.5px solid #3b82f6',
                  boxSizing: 'border-box',
                  pointerEvents: 'none'
                }}>
                  <div 
                    className="export-marker-out"
                    onMouseDown={(e) => handleExportLimitDragMouseDown(e, 'end')}
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                    }}
                    title="ドラッグして範囲微調整"
                  />
                </div>
              )}
            </div>
          </>
        )}

        {/* Waveforms (右カラムには波形行だけを出力) */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0', marginTop: '8px' }}>
          {tracks.map((track) => {
            const trackColor = getTrackColor(track, tracks);
            const isDraggable = !track.isRef;
            const isPinnedRow = track.isRef && isRefPinned;

            return (
              <div
                key={track.id}
                className={`track-waveform-row ${isPinnedRow ? 'pinned' : ''}`}
                style={{
                  width: `${timelineWidth}px`,
                  height: '63px',
                  position: isPinnedRow ? 'sticky' : 'relative',
                  top: isPinnedRow ? '52px' : 'auto',
                  zIndex: isPinnedRow ? 75 : 'auto',
                  backgroundColor: isPinnedRow ? '#0f172a' : 'transparent',
                  boxShadow: isPinnedRow ? '0 4px 6px -1px rgba(0,0,0,0.3)' : 'none',
                  transition: 'border 0.2s, background 0.2s',
                  borderBottom: '1px solid rgba(255,255,255,0.05)',
                  borderTop: '1px solid transparent',
                  borderLeft: '1px solid transparent',
                  borderRight: '1px solid transparent',
                  background: (isDraggable && isAltPressed) ? 'rgba(255,255,255,0.02)' : 'transparent',
                  cursor: (isDraggable && isAltPressed) ? 'ew-resize' : 'default',
                  flexShrink: 0,
                  boxSizing: 'border-box',
                  ...((isDraggable && isAltPressed) ? {
                    border: '1px dashed rgba(255,255,255,0.3)'
                  } : {})
                }}
                onMouseDown={(e) => handleWaveformMouseDown(e, track)}
              >
                <WaveformRenderer 
                  peaks={track.peaks} 
                  pixelsPerSecond={pixelsPerSecond} 
                  offsetSeconds={track.offsetSeconds} 
                  color={trackColor} 
                  width={timelineWidth}
                  scrollContainerRef={containerRef}
                />
              </div>
            );
          })}
        </div>
      </div>
    </div>

    {/* Playhead Overlay: 表示エリア内に常に固定表示し、横スクロール位置だけを反映する */}
    <div style={{
      position: 'absolute',
      top: 0,
      bottom: 0,
      left: '180px',
      right: 0,
      overflow: 'hidden',
      pointerEvents: 'none',
      zIndex: 95
    }}>
      <div
        ref={playheadLineRef}
        className="playhead"
        style={{
          position: 'absolute',
          top: 0,
          bottom: 0,
          left: `${currentTime * pixelsPerSecond - lastScrollLeftRef.current}px`,
          width: '2px',
          background: '#ef4444',
          pointerEvents: 'none'
        }}
      >
        <div style={{
          position: 'absolute',
          top: 0,
          left: '-6px',
          width: '14px',
          height: '14px',
          background: '#ef4444',
          clipPath: 'polygon(0 0, 100% 0, 50% 100%)'
        }} />
      </div>
    </div>

      {contextMenu && (
        <div 
          style={{
            position: 'fixed',
            top: contextMenu.y,
            left: contextMenu.x,
            background: '#1e293b',
            border: '1px solid #475569',
            borderRadius: '6px',
            boxShadow: '0 10px 25px -5px rgba(0,0,0,0.5)',
            zIndex: 1000,
            padding: '6px 0',
            width: (contextMenu.ribbonSegment || contextMenu.trackId) ? '200px' : '150px',
            userSelect: 'none'
          }}
          onClick={e => e.stopPropagation()}
          onContextMenu={e => e.preventDefault()}
        >
          {/* ヘッダー: トラック名 or 時間表示 */}
          <div style={{ padding: '4px 12px', fontSize: '0.65rem', color: '#94a3b8', borderBottom: '1px solid #334155', marginBottom: '4px', fontFamily: 'monospace', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {contextMenu.trackId
              ? (tracks.find(t => t.id === contextMenu.trackId)?.name ?? '')
              : `位置: ${formatTimecode(contextMenu.time)}`}
          </div>

          {contextMenu.trackId ? (() => {
            const track = tracks.find(t => t.id === contextMenu.trackId);
            if (!track) return null;
            const itemStyle = (disabled?: boolean): React.CSSProperties => ({
              width: '100%', padding: '6px 12px', background: 'transparent', border: 'none',
              color: disabled ? '#64748b' : '#e2e8f0', textAlign: 'left',
              cursor: disabled ? 'default' : 'pointer', fontSize: '0.75rem'
            });
            const onEnter = (disabled?: boolean) => (e: React.MouseEvent<HTMLButtonElement>) => {
              if (!disabled) e.currentTarget.style.background = 'rgba(255,255,255,0.08)';
            };
            const onLeave = (e: React.MouseEvent<HTMLButtonElement>) => { e.currentTarget.style.background = 'transparent'; };
            const divider = <div style={{ borderTop: '1px solid #334155', margin: '4px 0' }} />;

            const isPreviewing = track.id === activePreviewCameraId;
            const isAlreadySynced = (track as any).lastAutoSyncedOffset !== undefined;
            const syncAllDisabled = isProcessing || tracks.filter(t => !t.isRef).every(t => (t as any).lastAutoSyncedOffset !== undefined || t.isLocked);
            const autoSyncDisabled = isProcessing || isAlreadySynced || !!track.isLocked;
            const resetOffsetDisabled = !!track.isLocked || track.offsetSeconds === 0;

            return (
              <>
                {!track.isAudioOnly && (
                  <>
                    <button
                      disabled={isPreviewing}
                      onClick={() => { if (!isPreviewing) { onAngleChangeRequested?.(track.id); setContextMenu(null); } }}
                      style={itemStyle(isPreviewing)}
                      onMouseEnter={onEnter(isPreviewing)}
                      onMouseLeave={onLeave}
                    >
                      このカメラをプレビュー
                    </button>
                    {divider}
                  </>
                )}

                <button
                  onClick={() => {
                    setEditingTrackId(track.id);
                    setEditingName(track.name);
                    setContextMenu(null);
                  }}
                  style={itemStyle()}
                  onMouseEnter={onEnter()}
                  onMouseLeave={onLeave}
                >
                  名前を変更
                </button>

                {track.isRef ? (
                  <>
                    {onSyncAllTracks && tracks.length > 1 && (
                      <>
                        {divider}
                        <button
                          disabled={syncAllDisabled}
                          onClick={() => { if (!syncAllDisabled) { onSyncAllTracks(); setContextMenu(null); } }}
                          style={itemStyle(syncAllDisabled)}
                          onMouseEnter={onEnter(syncAllDisabled)}
                          onMouseLeave={onLeave}
                        >
                          すべて同期 (Sync All)
                        </button>
                      </>
                    )}
                  </>
                ) : (
                  <>
                    {divider}
                    <button
                      disabled={resetOffsetDisabled}
                      onClick={() => { if (!resetOffsetDisabled) { onTrackOffsetChange?.(track.id, 0, true); setContextMenu(null); } }}
                      style={itemStyle(resetOffsetDisabled)}
                      onMouseEnter={onEnter(resetOffsetDisabled)}
                      onMouseLeave={onLeave}
                    >
                      オフセットをリセット
                    </button>
                    {onSyncTrack && (
                      <button
                        disabled={autoSyncDisabled}
                        onClick={() => { if (!autoSyncDisabled) { onSyncTrack(track.id); setContextMenu(null); } }}
                        style={itemStyle(autoSyncDisabled)}
                        onMouseEnter={onEnter(autoSyncDisabled)}
                        onMouseLeave={onLeave}
                      >
                        自動同期を実行
                      </button>
                    )}
                    {onToggleLockTrack && (
                      <button
                        onClick={() => { onToggleLockTrack(track.id); setContextMenu(null); }}
                        style={itemStyle()}
                        onMouseEnter={onEnter()}
                        onMouseLeave={onLeave}
                      >
                        {track.isLocked ? 'オフセットのロックを解除' : 'オフセットをロック'}
                      </button>
                    )}
                  </>
                )}

                {onTrackDelete && (
                  <>
                    {divider}
                    <button
                      onClick={() => { onTrackDelete(track.id); setContextMenu(null); }}
                      style={{ ...itemStyle(), color: '#f87171', fontWeight: 'bold' }}
                      onMouseEnter={e => e.currentTarget.style.background = 'rgba(239, 68, 68, 0.1)'}
                      onMouseLeave={onLeave}
                    >
                      トラックを削除
                    </button>
                  </>
                )}
              </>
            );
          })() : (
          <>
          {/* リボン右クリック: カメラ切り替えセクション */}
          {contextMenu?.ribbonSegment ? (
            <>
              <div style={{ padding: '4px 12px 6px', fontSize: '0.65rem', color: '#94a3b8', borderBottom: '1px solid #334155', marginBottom: '4px', fontFamily: 'monospace' }}>
                セグメントのカメラを変更
              </div>
              {tracks.filter(t => !t.isAudioOnly).map((t) => {
                const trackColor = getTrackColor(t, tracks);
                const isCurrent = t.id === contextMenu.ribbonSegment!.cameraId;
                return (
                  <button
                    key={t.id}
                    onClick={() => handleChangeRibbonCamera(t.id)}
                    disabled={isCurrent}
                    style={{
                      width: '100%', padding: '6px 12px', background: isCurrent ? 'rgba(255,255,255,0.06)' : 'transparent',
                      border: 'none', color: isCurrent ? '#fff' : '#e2e8f0',
                      textAlign: 'left', cursor: isCurrent ? 'default' : 'pointer',
                      fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: '8px'
                    }}
                    onMouseEnter={e => { if (!isCurrent) e.currentTarget.style.background = 'rgba(255,255,255,0.08)'; }}
                    onMouseLeave={e => { if (!isCurrent) e.currentTarget.style.background = 'transparent'; }}
                  >
                    <div style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: trackColor, flexShrink: 0 }} />
                    <span style={{ flex: 1 }}>{t.name}</span>
                    {isCurrent && (
                      <span style={{ fontSize: '0.7rem', color: '#94a3b8', display: 'flex', alignItems: 'center', gap: '2px' }}>
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'inline-block' }}>
                          <polyline points="20 6 9 17 4 12"/>
                        </svg>
                        現在
                      </span>
                    )}
                  </button>
                );
              })}
            </>
          ) : (
            <>
              {/* 各アングルへの切り替え（カット追加） */}
              {(() => {
                const intervals = calculateAngleIntervals();
                const currentInterval = intervals.find(
                  interval => contextMenu.time >= interval.startTime && contextMenu.time <= interval.endTime
                );
                const currentCameraIdAtTime = currentInterval?.cameraId;

                return tracks.filter(t => !t.isAudioOnly).map((t) => {
                  const trackColor = getTrackColor(t, tracks);
                  const isCurrent = t.id === currentCameraIdAtTime;
                  return (
                    <button
                      key={t.id}
                      onClick={() => !isCurrent && handleAddCutAtClick(t.id)}
                      disabled={isCurrent}
                      style={{
                        width: '100%',
                        padding: '6px 12px',
                        background: 'transparent',
                        border: 'none',
                        color: isCurrent ? '#64748b' : '#e2e8f0',
                        textAlign: 'left',
                        cursor: isCurrent ? 'not-allowed' : 'pointer',
                        fontSize: '0.75rem',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '8px',
                        opacity: isCurrent ? 0.5 : 1
                      }}
                      onMouseEnter={e => {
                        if (!isCurrent) e.currentTarget.style.background = 'rgba(255,255,255,0.08)';
                      }}
                      onMouseLeave={e => {
                        if (!isCurrent) e.currentTarget.style.background = 'transparent';
                      }}
                    >
                      <div style={{ width: '6px', height: '6px', borderRadius: '50%', backgroundColor: trackColor }} />
                      {t.name} にカット
                    </button>
                  );
                });
              })()}
            </>
          )}

          <div style={{ borderTop: '1px solid #334155', margin: '4px 0' }} />

          {/* 書き出し範囲設定 (インライン横並び) */}
          <div style={{ display: 'flex', gap: '4px', padding: '0 8px', marginBottom: '4px' }}>
            <button
              onClick={handleSetExportStart}
              style={{
                flex: 1, height: '28px', display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: 'rgba(255,255,255,0.05)', border: '1px solid #475569',
                borderRadius: '4px', color: '#e2e8f0', cursor: 'pointer',
                transition: 'all 0.15s'
              }}
              onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.12)'}
              onMouseLeave={e => e.currentTarget.style.background = 'rgba(255,255,255,0.05)'}
              title="この位置を書き出し始点に設定"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M19 4H9a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10" />
                <path d="M12 12h5" />
                <polyline points="14 9 17 12 14 15" />
              </svg>
            </button>
            <button
              onClick={handleSetExportEnd}
              style={{
                flex: 1, height: '28px', display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: 'rgba(255,255,255,0.05)', border: '1px solid #475569',
                borderRadius: '4px', color: '#e2e8f0', cursor: 'pointer',
                transition: 'all 0.15s'
              }}
              onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.12)'}
              onMouseLeave={e => e.currentTarget.style.background = 'rgba(255,255,255,0.05)'}
              title="この位置を書き出し終点に設定"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 4h10a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5" />
                <path d="M12 12H7" />
                <polyline points="10 9 7 12 10 15" />
              </svg>
            </button>
          </div>
          
          {exportRange?.useRange && (
            <button
              onClick={handleClearExportRange}
              style={{
                width: '100%', padding: '4px 12px', background: 'transparent', border: 'none',
                color: '#94a3b8', textAlign: 'left', cursor: 'pointer', fontSize: '0.7rem'
              }}
              onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.08)'}
              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
            >
              範囲選択をクリア
            </button>
          )}

          {/* 近くにあるカットポイントの削除 */}
          {(() => {
            const nearbyCut = getNearbyCut();
            if (nearbyCut) {
              return (
                <>
                  <div style={{ borderTop: '1px solid #334155', margin: '4px 0' }} />
                  <button
                    onClick={() => {
                      if (onCutDelete) {
                        onCutDelete(nearbyCut.id);
                        setContextMenu(null);
                      }
                    }}
                    style={{
                      width: '100%', padding: '6px 12px', background: 'transparent', border: 'none',
                      color: '#ef4444', textAlign: 'left', cursor: 'pointer', fontSize: '0.75rem', fontWeight: 'bold',
                      display: 'flex', alignItems: 'center', gap: '6px'
                    }}
                    onMouseEnter={e => e.currentTarget.style.background = 'rgba(239, 68, 68, 0.1)'}
                    onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'inline-block' }}>
                      <polyline points="3 6 5 6 21 6"/>
                      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                      <line x1="10" y1="11" x2="10" y2="17"/>
                      <line x1="14" y1="11" x2="14" y2="17"/>
                    </svg>
                    カットを削除
                  </button>
                </>
              );
            }
            return null;
          })()}
          </>
          )}
        </div>
      )}
    </div>
  );
}
