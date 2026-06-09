import React, { useEffect, useRef, useState } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { audioEngine } from './AudioEngine';
import { getTrackColor } from './Timeline';
import type { TrackData, CutPoint, ExportRange } from './types';

interface VideoPreviewProps {
  tracks: TrackData[];
  cuts: CutPoint[];
  currentTime: number;
  isPlaying: boolean;
  masterVolume: number;
  onAngleChangeRequested: (cameraId: string) => void;
  isDraggingOffset?: boolean;
  isGridView?: boolean;
  onToggleGridView?: () => void;
  previewOverrideCameraId: string | null;
  onClearPreviewOverride?: () => void;
  exportRange?: ExportRange;
  onForceAddCut?: (cameraId: string) => void;
  onSyncStateChange?: (isSyncing: boolean) => void;
  onSetExportStart?: () => void;
  onSetExportEnd?: () => void;
}

export function VideoPreview({ 
  tracks, 
  cuts, 
  currentTime, 
  isPlaying, 
  masterVolume, 
  onAngleChangeRequested,
  isDraggingOffset = false,
  isGridView = false,
  onToggleGridView,
  previewOverrideCameraId,
  onClearPreviewOverride,
  exportRange,
  onForceAddCut,
  onSyncStateChange,
  onSetExportStart,
  onSetExportEnd
}: VideoPreviewProps) {
  const videoRefs = useRef<{ [id: string]: HTMLVideoElement | null }>({});
  const [videoError, setVideoError] = React.useState<string | null>(null);
  const [isPipHovered, setIsPipHovered] = useState(false);
  const [isGridHovered, setIsGridHovered] = useState(false);

  const [dimensions, setDimensions] = useState({ width: 640, height: 360 });
  const observerRef = useRef<ResizeObserver | null>(null);
  const lastSeekTimes = useRef<{ [id: string]: number }>({});
  const lastOffsets = useRef<{ [id: string]: number }>({});
  const lastPlaybackRates = useRef<{ [id: string]: number }>({});
  const lastRateChangeTimes = useRef<{ [id: string]: number }>({});
  const initialSyncDone = useRef<{ [id: string]: boolean }>({});
  const audioRefs = useRef<{ [id: string]: HTMLVideoElement | null }>({});
  const lastAudioSeekTimes = useRef<{ [id: string]: number }>({});

  // 右クリックコンテキストメニュー（プレビューエリア）
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    cameraId: string;
    isMainView: boolean;
    isEmptyArea?: boolean;
  } | null>(null);

  useEffect(() => {
    const closeMenu = () => setContextMenu(null);
    window.addEventListener('click', closeMenu);
    return () => window.removeEventListener('click', closeMenu);
  }, []);

  const handleTileContextMenu = (e: React.MouseEvent, cameraId: string, isMainView: boolean, isEmptyArea?: boolean) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, cameraId, isMainView, isEmptyArea });
  };

  const containerRef = React.useCallback((node: HTMLDivElement | null) => {
    if (observerRef.current) {
      observerRef.current.disconnect();
      observerRef.current = null;
    }

    if (node) {
      const observer = new ResizeObserver(entries => {
        if (entries[0]) {
          setDimensions({
            width: entries[0].contentRect.width,
            height: entries[0].contentRect.height
          });
        }
      });
      observer.observe(node);
      observerRef.current = observer;
    }
  }, []);

  // 現在オンエアされているカメラID (カットに基づく)
  let onAirCameraId = tracks.find(t => t.isRef && !t.isAudioOnly)?.id || tracks.find(t => !t.isAudioOnly)?.id || tracks[0]?.id;
  let previousCameraId: string | null = null;
  let activeTransition: any = 'cut';
  let transitionProgress = 1.0;
  
  const sortedCuts = [...cuts].sort((a, b) => a.timeSeconds - b.timeSeconds);
  for (const cut of sortedCuts) {
    if (currentTime >= cut.timeSeconds) {
      previousCameraId = onAirCameraId;
      onAirCameraId = cut.cameraId;
      
      if (cut.transition !== 'cut' && cut.transitionDuration > 0) {
        const timeSinceCut = currentTime - cut.timeSeconds;
        if (timeSinceCut < cut.transitionDuration) {
          activeTransition = cut.transition;
          transitionProgress = timeSinceCut / cut.transitionDuration; // 0.0 to 1.0
        } else {
          activeTransition = 'cut';
          transitionProgress = 1.0;
        }
      } else {
        activeTransition = 'cut';
        transitionProgress = 1.0;
      }
    } else {
      break;
    }
  }

  // プレビュー表示対象のカメラIDを決定
  const activeCameraId = previewOverrideCameraId !== null ? previewOverrideCameraId : onAirCameraId;

  // プレビューオーバーライド時はトランジション効果を適用しない
  if (previewOverrideCameraId !== null) {
    previousCameraId = null;
    activeTransition = 'cut';
    transitionProgress = 1.0;
  }

  // トランジションが完了したらpreviousは不要
  if (transitionProgress >= 1.0) {
    previousCameraId = null;
    activeTransition = 'cut';
  }

  let whiteOverlayOpacity = 0.0;
  if (previousCameraId !== null && activeTransition === 'dip_to_white') {
    whiteOverlayOpacity = transitionProgress < 0.5 ? transitionProgress * 2 : (1.0 - transitionProgress) * 2;
  }

  // 1. AudioEngine 接続とステータス更新、およびRef辞書のクリーンアップ
  React.useEffect(() => {
    const currentIds = new Set(tracks.map(t => t.id));
    
    // 不要になった音声接続を削除
    for (const connectedId of Array.from(audioEngine.trackNodes.keys())) {
      if (!currentIds.has(connectedId)) {
        audioEngine.removeTrack(connectedId);
      }
    }

    // Ref辞書のクリーンアップ（メモリリーク・競合防止）
    Object.keys(videoRefs.current).forEach(id => {
      if (!currentIds.has(id)) delete videoRefs.current[id];
    });
    Object.keys(audioRefs.current).forEach(id => {
      if (!currentIds.has(id)) delete audioRefs.current[id];
    });
    Object.keys(lastSeekTimes.current).forEach(id => {
      if (!currentIds.has(id)) delete lastSeekTimes.current[id];
    });
    Object.keys(lastOffsets.current).forEach(id => {
      if (!currentIds.has(id)) delete lastOffsets.current[id];
    });
    Object.keys(lastPlaybackRates.current).forEach(id => {
      if (!currentIds.has(id)) delete lastPlaybackRates.current[id];
    });
    Object.keys(lastRateChangeTimes.current).forEach(id => {
      if (!currentIds.has(id)) delete lastRateChangeTimes.current[id];
    });
    Object.keys(initialSyncDone.current).forEach(id => {
      if (!currentIds.has(id)) delete initialSyncDone.current[id];
    });
    Object.keys(lastAudioSeekTimes.current).forEach(id => {
      if (!currentIds.has(id)) delete lastAudioSeekTimes.current[id];
    });
    Object.keys(lastShouldVideoBePlaying.current).forEach(id => {
      if (!currentIds.has(id)) delete lastShouldVideoBePlaying.current[id];
    });
    Object.keys(lastShouldAudioBePlaying.current).forEach(id => {
      if (!currentIds.has(id)) delete lastShouldAudioBePlaying.current[id];
    });
    Object.keys(playPromises.current).forEach(key => {
      const trackId = key.replace(/_(video|audio)$/, '');
      if (!currentIds.has(trackId)) delete playPromises.current[key];
    });

    const anySoloed = tracks.some(t => t.audioState.isSoloed);

    tracks.forEach(track => {
      const audio = audioRefs.current[track.id];
      if (!audio) return;
      
      audioEngine.connectVideo(track.id, audio);
      audioEngine.updateTrackState(track.id, track.audioState, anySoloed);
      
      // Web Audio API を通すため、ネイティブのミュートは常に解除
      audio.muted = false;
    });
  }, [tracks, isGridView]);

  // プレビュー再生時のボリュームに対するフェードイン・フェードアウトの適用
  React.useEffect(() => {
    let targetVolume = masterVolume;
    if (exportRange && exportRange.useRange) {
      if (exportRange.fadeIn && exportRange.fadeInDuration) {
        const start = exportRange.start;
        const dur = exportRange.fadeInDuration;
        if (currentTime >= start && currentTime < start + dur) {
          const factor = (currentTime - start) / dur;
          targetVolume *= factor;
        }
      }
      if (exportRange.fadeOut && exportRange.fadeOutDuration) {
        const end = exportRange.end;
        const dur = exportRange.fadeOutDuration;
        if (currentTime > end - dur && currentTime <= end) {
          const factor = (end - currentTime) / dur;
          targetVolume *= factor;
        }
      }
    }
    audioEngine.setMasterVolume(targetVolume);
  }, [currentTime, masterVolume, exportRange]);

  const prevDraggingOffset = useRef(false);
  const lastShouldVideoBePlaying = useRef<{ [id: string]: boolean }>({});
  const lastShouldAudioBePlaying = useRef<{ [id: string]: boolean }>({});

  const playPromises = useRef<{ [id: string]: Promise<void> | null }>({});

  const safePlay = (el: HTMLMediaElement, key: string) => {
    if (!el || isNaN(el.duration)) return;
    if (playPromises.current[key]) {
      return;
    }
    const p = el.play();
    if (p !== undefined) {
      playPromises.current[key] = p;
      p.then(() => {
        playPromises.current[key] = null;
      }).catch(e => {
        playPromises.current[key] = null;
        if (e.name !== 'AbortError' && e.name !== 'NotAllowedError') {
          console.error("Play failed for key:", key, e);
        }
      });
    }
  };

  const safePause = (el: HTMLMediaElement, key: string) => {
    if (!el) return;
    const playPromise = playPromises.current[key];
    if (playPromise) {
      playPromise.then(() => {
        if (!isPlayingRef.current) {
          el.pause();
        }
      }).catch(() => {
        el.pause();
      });
    } else {
      el.pause();
    }
  };

  // 最新の React 状態を保持する Ref グループ (rAFループ用)
  const currentTimeRef = useRef(currentTime);
  const isPlayingRef = useRef(isPlaying);
  const tracksRef = useRef(tracks);
  const activeCameraIdRef = useRef(activeCameraId);
  const previousCameraIdRef = useRef(previousCameraId);
  const isGridViewRef = useRef(isGridView);
  const isDraggingOffsetRef = useRef(isDraggingOffset);

  // 毎レンダリングごとに最新値を同期
  currentTimeRef.current = currentTime;
  isPlayingRef.current = isPlaying;
  tracksRef.current = tracks;
  activeCameraIdRef.current = activeCameraId;
  previousCameraIdRef.current = previousCameraId;
  isGridViewRef.current = isGridView;
  isDraggingOffsetRef.current = isDraggingOffset;

  // 同期ステータス管理用の Ref グループ
  const isSyncingRef = useRef(false);
  const syncStartTimeRef = useRef(0);
  const lastSyncCompletedTimeRef = useRef(0);
  const prevTimeRef = useRef(currentTime);
  const prevPlayingRef = useRef(isPlaying);
  const onSyncStateChangeRef = useRef(onSyncStateChange);
  useEffect(() => { onSyncStateChangeRef.current = onSyncStateChange; }, [onSyncStateChange]);

  // オフセットドラッグ終了時の吸着処理
  useEffect(() => {
    if (prevDraggingOffset.current && !isDraggingOffset) {
      const now = performance.now();
      tracks.forEach(track => {
        const video = videoRefs.current[track.id];
        if (!video) return;
        if (track.isRef) return;

        const targetTime = currentTime - track.offsetSeconds;
        const validTime = Math.max(0, targetTime);
        
        video.currentTime = validTime;
        lastSeekTimes.current[track.id] = now;
        video.playbackRate = 1.0;
        lastPlaybackRates.current[track.id] = 1.0;
        
        const shouldBePlaying = isPlaying && targetTime >= 0 && validTime < video.duration;
        if (shouldBePlaying && video.paused) {
          safePlay(video, `${track.id}_video`);
        }
      });
    }
    prevDraggingOffset.current = isDraggingOffset;
  }, [isDraggingOffset, currentTime, isPlaying, tracks, isGridView]);

  // 停止中に currentTime が変化したとき各動画要素を即時シーク（フレームステップ等）
  useEffect(() => {
    if (isPlaying || isDraggingOffset) return;
    tracks.forEach(track => {
      const video = videoRefs.current[track.id];
      if (!video || track.isAudioOnly || isNaN(video.duration)) return;
      const targetTime = currentTime - track.offsetSeconds;
      const validTime = Math.max(0, targetTime);
      if (Math.abs(video.currentTime - validTime) > 0.005) {
        video.currentTime = validTime;
      }
    });
  }, [currentTime, isPlaying, isDraggingOffset, tracks]);

  // 高頻度ポーリングによる再生同期監視ループ（ポーリングループ）
  useEffect(() => {
    let animationFrameId: number;

    const syncLoop = () => {
      const current = currentTimeRef.current;
      const playing = isPlayingRef.current;
      const currentTracks = tracksRef.current;
      const grid = isGridViewRef.current;
      const dragging = isDraggingOffsetRef.current;
      const activeCam = activeCameraIdRef.current;
      const prevCam = previousCameraIdRef.current;

      const now = performance.now();

      // 1. ジャンプ（シーク）および再生開始の検知
      // 0.15秒（150ms）以上の変動をジャンプとみなす（高負荷時のフレームスキップによる誤発火を軽減）
      const timeJumped = Math.abs(current - prevTimeRef.current) > 0.15;
      const playStarted = playing && !prevPlayingRef.current;

      prevPlayingRef.current = playing;
      prevTimeRef.current = current;

      // 同期中に再トリガーしない（同期自体が引き起こすcurrentTimeの変動で連鎖しないように）
      const shouldSync = playStarted || (timeJumped && !isSyncingRef.current);
      if (shouldSync) {
        isSyncingRef.current = true;
        onSyncStateChangeRef.current?.(true);
        syncStartTimeRef.current = now;

        // 全トラックの同期待ち状態を初期化
        currentTracks.forEach(track => {
          initialSyncDone.current[track.id] = false;
          lastSeekTimes.current[track.id] = 0;
          lastAudioSeekTimes.current[track.id] = 0;
        });

        // 内部で一律一時停止（pause）し、全要素の currentTime を一斉シーク
        currentTracks.forEach(track => {
          const video = videoRefs.current[track.id];
          const audio = audioRefs.current[track.id];

          if (video && !track.isAudioOnly && !isNaN(video.duration)) {
            safePause(video, `${track.id}_video`);
            const targetTime = current - track.offsetSeconds;
            const validTime = Math.max(0, targetTime);
            video.currentTime = validTime;
            video.playbackRate = 1.0;
            lastPlaybackRates.current[track.id] = 1.0;
            lastSeekTimes.current[track.id] = now;
          }

          if (audio && !isNaN(audio.duration)) {
            safePause(audio, `${track.id}_audio`);
            const audioTargetTime = current - (track.offsetSeconds + (track.audioOffsetSeconds || 0));
            const audioValidTime = Math.max(0, audioTargetTime);
            audio.currentTime = audioValidTime;
            audio.playbackRate = 1.0;
            lastAudioSeekTimes.current[track.id] = now;
          }
        });
      }

      // 2. 一斉同期待機（完全同期一斉スタート判定）
      if (isSyncingRef.current) {
        let allReady = true;
        // 表示中の映像トラック、およびすべての参照/オーディオトラックを監視対象にする
        const activeTracks = currentTracks.filter(t => grid || t.id === activeCam || t.id === prevCam || t.isRef);

        activeTracks.forEach(track => {
          const video = videoRefs.current[track.id];
          const audio = audioRefs.current[track.id];

          // 映像トラックのデコード準備完了チェック
          if (video && !track.isAudioOnly && !isNaN(video.duration)) {
            const targetTime = current - track.offsetSeconds;
            if (targetTime >= 0 && targetTime < video.duration) {
              if (video.seeking || video.readyState < 2) {
                allReady = false;
              }
            }
          }

          // 音声トラックのデコード準備完了チェック
          if (audio && !isNaN(audio.duration)) {
            const audioTargetTime = current - (track.offsetSeconds + (track.audioOffsetSeconds || 0));
            if (audioTargetTime >= 0 && audioTargetTime < audio.duration) {
              if (audio.seeking || audio.readyState < 2) {
                allReady = false;
              }
            }
          }
        });

        const syncDuration = now - syncStartTimeRef.current;
        const timeout = syncDuration > 500; // 最大500msの待機制限

        if (allReady || timeout) {
          isSyncingRef.current = false;
          lastSyncCompletedTimeRef.current = now;
          onSyncStateChangeRef.current?.(false);
          // すべて準備できたので、再生中であれば全要素を一斉に play する
          if (playing) {
            currentTracks.forEach(track => {
              const video = videoRefs.current[track.id];
              const audio = audioRefs.current[track.id];

              if (video && !track.isAudioOnly && !isNaN(video.duration)) {
                const targetTime = current - track.offsetSeconds;
                if (targetTime >= 0 && targetTime < video.duration) {
                  safePlay(video, `${track.id}_video`);
                }
              }
              if (audio && !isNaN(audio.duration)) {
                const audioTargetTime = current - (track.offsetSeconds + (track.audioOffsetSeconds || 0));
                if (audioTargetTime >= 0 && audioTargetTime < audio.duration) {
                  safePlay(audio, `${track.id}_audio`);
                }
              }
            });
          }
        }
      } else {
        // 3. 通常再生時および一時停止時の同期制御
        currentTracks.forEach(track => {
          const video = videoRefs.current[track.id];
          const audio = audioRefs.current[track.id];

          const baseTargetTime = current - track.offsetSeconds;
          const targetTime = baseTargetTime;
          const validTime = Math.max(0, targetTime);

          const audioTargetTime = current - (track.offsetSeconds + (track.audioOffsetSeconds || 0));
          const audioValidTime = Math.max(0, audioTargetTime);

          const isVideoEnded = video ? (validTime >= video.duration) : true;
          const isAudioEnded = audio ? (audioValidTime >= audio.duration) : true;

          const isMainView = track.id === activeCam || track.id === prevCam;
          const shouldVideoBePlaying = playing && baseTargetTime >= 0 && !isVideoEnded;
          const shouldAudioBePlaying = playing && audioTargetTime >= 0 && !isAudioEnded;

          const wasShouldVideoBePlaying = !!lastShouldVideoBePlaying.current[track.id];
          lastShouldVideoBePlaying.current[track.id] = shouldVideoBePlaying;

          const wasShouldAudioBePlaying = !!lastShouldAudioBePlaying.current[track.id];
          lastShouldAudioBePlaying.current[track.id] = shouldAudioBePlaying;

          // オフセットが明示的に変更されたかを監視
          const prevOffset = lastOffsets.current[track.id];
          const offsetChanged = prevOffset !== undefined && prevOffset !== track.offsetSeconds;
          lastOffsets.current[track.id] = track.offsetSeconds;

          // ----------------------------------------------------
          // A. 映像用ビデオ要素の制御
          // ----------------------------------------------------
          if (video && !track.isAudioOnly && !isNaN(video.duration)) {
            const videoDrift = Math.abs(video.currentTime - validTime);

            if (!playing || dragging || offsetChanged) {
              // 停止中、スクラブ中、ドラッグ中のシーク（ハード吸着）
              if (videoDrift > 0.02 || offsetChanged) {
                const timeSinceLastSeek = now - (lastSeekTimes.current[track.id] || 0);
                const isScrubbing = !playing && !dragging;
                const throttleLimit = isScrubbing ? 60 : 0;

                const isVisible = grid || isMainView || track.isRef;
                if (isScrubbing && !isVisible) {
                  // 非表示トラックは無駄なシークを行わない
                } else {
                  if ((timeSinceLastSeek > throttleLimit || offsetChanged) && (dragging || offsetChanged || !video.seeking) && video.readyState >= 2) {
                    video.currentTime = validTime;
                    lastSeekTimes.current[track.id] = now;
                    video.playbackRate = 1.0;
                    lastPlaybackRates.current[track.id] = 1.0;
                  }
                }
              }

              if (!shouldVideoBePlaying && !video.paused) {
                safePause(video, `${track.id}_video`);
              }
            } else {
              // 通常再生時の制御（★不感帯付きマクロ補正★）
              if (shouldVideoBePlaying) {
                if (video.paused) {
                  // 開始時吸着
                  if (!wasShouldVideoBePlaying || offsetChanged) {
                    if (videoDrift > 0.02 || offsetChanged) {
                      video.currentTime = validTime;
                      lastSeekTimes.current[track.id] = now;
                    }
                    video.playbackRate = 1.0;
                    lastPlaybackRates.current[track.id] = 1.0;
                  }
                  safePlay(video, `${track.id}_video`);
                } else if (!video.seeking) {
                  const timeSinceLastSeek = now - (lastSeekTimes.current[track.id] || 0);
                  // 同期直後はオーディオ起動遅延でズレが一時的に大きく見えるため、レート制御をスキップ
                  const postSyncCooldown = (now - lastSyncCompletedTimeRef.current) < 500;

                  if (postSyncCooldown) {
                    // 同期後クールダウン中: 速度を1.0xに戻すだけで干渉しない
                    if (video.playbackRate !== 1.0) {
                      video.playbackRate = 1.0;
                      lastPlaybackRates.current[track.id] = 1.0;
                    }
                  } else if (videoDrift < 0.017) {
                    // 1) ズレが 17ms 未満の不感帯: playbackRate を 1.0 (等倍速) に維持して干渉しない
                    if (video.playbackRate !== 1.0) {
                      video.playbackRate = 1.0;
                      lastPlaybackRates.current[track.id] = 1.0;
                    }
                  } else if (videoDrift <= 0.25) {
                    // 2) ズレが 17ms 〜 250ms の間: ズレに比例したマイルドなソフト追従（最大±3%制限、ハードシーク回避）
                    const diff = validTime - video.currentTime;
                    const kP = 0.15;
                    const rateAdjustment = Math.max(-0.03, Math.min(0.03, diff * kP));
                    const targetRate = 1.0 + rateAdjustment;

                    const currentRate = lastPlaybackRates.current[track.id] ?? 1.0;
                    if (Math.abs(currentRate - targetRate) > 0.002) {
                      video.playbackRate = targetRate;
                      lastPlaybackRates.current[track.id] = targetRate;
                    }
                  } else {
                    // 3) ズレが 250ms 超: ハードシークで一気に修正
                    if (timeSinceLastSeek > 500 && video.readyState >= 2) {
                      video.currentTime = validTime;
                      lastSeekTimes.current[track.id] = now;
                      video.playbackRate = 1.0;
                      lastPlaybackRates.current[track.id] = 1.0;
                    }
                  }
                }
              } else if (!shouldVideoBePlaying && !video.paused) {
                safePause(video, `${track.id}_video`);
              }
            }

            // 末尾保護
            if (validTime >= video.duration && Math.abs(video.currentTime - video.duration) > 0.05 && !video.seeking) {
              video.currentTime = video.duration;
              lastSeekTimes.current[track.id] = now;
            }
          }

          // ----------------------------------------------------
          // B. 音声用メディア要素の制御
          // ----------------------------------------------------
          if (audio && !isNaN(audio.duration)) {
            const audioDrift = Math.abs(audio.currentTime - audioValidTime);

            if (audio.playbackRate !== 1.0) {
              audio.playbackRate = 1.0;
            }

            if (!playing || dragging || offsetChanged) {
              if (audioDrift > 0.02 || offsetChanged) {
                const timeSinceLastAudioSeek = now - (lastAudioSeekTimes.current[track.id] || 0);
                const isScrubbing = !playing && !dragging;
                const throttleLimit = isScrubbing ? 60 : 0;
                if ((timeSinceLastAudioSeek > throttleLimit || offsetChanged) && (dragging || offsetChanged || !audio.seeking) && audio.readyState >= 2) {
                  audio.currentTime = audioValidTime;
                  lastAudioSeekTimes.current[track.id] = now;
                }
              }
              if (!shouldAudioBePlaying && !audio.paused) {
                safePause(audio, `${track.id}_audio`);
              }
            } else {
              if (shouldAudioBePlaying) {
                if (audio.paused) {
                  if (!wasShouldAudioBePlaying || offsetChanged) {
                    if (audioDrift > 0.02 || offsetChanged) {
                      audio.currentTime = audioValidTime;
                      lastAudioSeekTimes.current[track.id] = now;
                    }
                  }
                  safePlay(audio, `${track.id}_audio`);
                } else if (!audio.seeking) {
                  const timeSinceLastAudioSeek = now - (lastAudioSeekTimes.current[track.id] || 0);

                  // 音声はピッチ変化を防ぐため playbackRate 変更を避け、100ms 以上のズレに対してのみ緩やかにシークで吸着
                  if (audioDrift > 0.10) {
                    if (timeSinceLastAudioSeek > 1500 && audio.readyState >= 2) {
                      audio.currentTime = audioValidTime;
                      lastAudioSeekTimes.current[track.id] = now;
                    }
                  }
                }
              } else if (!shouldAudioBePlaying && !audio.paused) {
                safePause(audio, `${track.id}_audio`);
              }
            }

            if (audioValidTime >= audio.duration && Math.abs(audio.currentTime - audio.duration) > 0.05 && !audio.seeking) {
              audio.currentTime = audio.duration;
              lastAudioSeekTimes.current[track.id] = now;
            }
          }
        });
      }

      animationFrameId = requestAnimationFrame(syncLoop);
    };

    animationFrameId = requestAnimationFrame(syncLoop);

    return () => {
      cancelAnimationFrame(animationFrameId);
    };
  }, []);

  const renderLayoutToggle = () => {
    if (!onToggleGridView) return null;
    const activeTrack = tracks.find(t => t.id === activeCameraId);
    return (
      <div 
        style={{
          position: 'absolute',
          top: '6px',
          right: '8px',
          zIndex: 150,
          display: 'flex',
          gap: '8px',
          alignItems: 'center',
          pointerEvents: 'auto'
        }}
      >
        {!isGridView && activeTrack && (
          <div style={{
            background: activeTrack.isRef ? '#4ade80' : 'rgba(0,0,0,0.65)',
            backdropFilter: activeTrack.isRef ? undefined : 'blur(6px)',
            color: activeTrack.isRef ? '#052e16' : 'white',
            padding: '3px 10px',
            borderRadius: '6px',
            fontSize: '0.85rem',
            fontWeight: 'bold',
            pointerEvents: 'none',
            letterSpacing: '-0.01em',
            border: `1px solid ${activeTrack.isRef ? '#4ade80' : 'rgba(255,255,255,0.15)'}`,
            height: '28px',
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            boxSizing: 'border-box',
            whiteSpace: 'nowrap'
          }}>
            {!activeTrack.isRef && (
              <span style={{ display: 'inline-block', width: '3px', height: '12px', background: getTrackColor(activeTrack, tracks), borderRadius: '1px', flexShrink: 0 }} />
            )}
            {activeTrack.name}
          </div>
        )}

        {previewOverrideCameraId !== null && (
          <button
            onClick={(e) => { e.stopPropagation(); onClearPreviewOverride?.(); }}
            style={{
              background: '#ef4444',
              color: '#fff',
              border: 'none',
              borderRadius: '50%',
              width: '28px',
              height: '28px',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: '0 2px 8px rgba(239, 68, 68, 0.4)',
              transition: 'all 0.2s',
              flexShrink: 0
            }}
            onMouseEnter={e => e.currentTarget.style.background = '#dc2626'}
            onMouseLeave={e => e.currentTarget.style.background = '#ef4444'}
            title="タイムラインの自動アングル追従に戻ります (Follow Timeline)"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
              <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
            </svg>
          </button>
        )}

        <div
          style={{
            display: 'flex',
            background: 'rgba(15, 23, 42, 0.8)',
            backdropFilter: 'blur(8px)',
            border: '1px solid rgba(255, 255, 255, 0.1)',
            borderRadius: '6px',
            padding: '2px',
            gap: '2px',
            boxShadow: '0 4px 12px rgba(0, 0, 0, 0.5)',
          }}
        >
          <button
            onClick={(e) => { e.stopPropagation(); if (isGridView) onToggleGridView(); }}
            onMouseEnter={() => setIsPipHovered(true)}
            onMouseLeave={() => setIsPipHovered(false)}
            style={{
              background: !isGridView 
                ? '#3b82f6' 
                : (isPipHovered ? 'rgba(255, 255, 255, 0.1)' : 'transparent'),
              border: 'none',
              borderRadius: '4px',
              width: '28px',
              height: '28px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: !isGridView ? 'default' : 'pointer',
              padding: 0,
              transition: 'all 0.15s ease'
            }}
            title="PiP View"
          >
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
              <rect x="8" y="2" width="8" height="14" rx="1" fill={!isGridView ? '#ffffff' : '#94a3b8'} opacity={!isGridView ? 1 : 0.7} />
              <rect x="2" y="3" width="4" height="5" rx="0.5" fill={!isGridView ? '#ffffff' : '#94a3b8'} opacity={!isGridView ? 1 : 0.7} />
              <rect x="2" y="10" width="4" height="5" rx="0.5" fill={!isGridView ? '#ffffff' : '#94a3b8'} opacity={!isGridView ? 1 : 0.7} />
            </svg>
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); if (!isGridView) onToggleGridView(); }}
            onMouseEnter={() => setIsGridHovered(true)}
            onMouseLeave={() => setIsGridHovered(false)}
            style={{
              background: isGridView 
                ? '#3b82f6' 
                : (isGridHovered ? 'rgba(255, 255, 255, 0.1)' : 'transparent'),
              border: 'none',
              borderRadius: '4px',
              width: '28px',
              height: '28px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: isGridView ? 'default' : 'pointer',
              padding: 0,
              transition: 'all 0.15s ease'
            }}
            title="Grid View"
          >
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
              <rect x="2" y="2" width="6" height="6" rx="0.75" fill={isGridView ? '#ffffff' : '#94a3b8'} opacity={isGridView ? 1 : 0.7} />
              <rect x="10" y="2" width="6" height="6" rx="0.75" fill={isGridView ? '#ffffff' : '#94a3b8'} opacity={isGridView ? 1 : 0.7} />
              <rect x="2" y="10" width="6" height="6" rx="0.75" fill={isGridView ? '#ffffff' : '#94a3b8'} opacity={isGridView ? 1 : 0.7} />
              <rect x="10" y="10" width="6" height="6" rx="0.75" fill={isGridView ? '#ffffff' : '#94a3b8'} opacity={isGridView ? 1 : 0.7} />
            </svg>
          </button>
        </div>
      </div>
    );
  };

  const renderHiddenAudioPlayers = () => {
    return (
      <div style={{ display: 'none' }} id="hidden-audio-players">
        {tracks.map(track => {
          const rawPath = track.proxyPath || track.path;
          const url = convertFileSrc(rawPath.replace(/\\/g, '/'));
          return (
            <video
              key={`audio_${track.id}`}
              ref={el => { audioRefs.current[track.id] = el; }}
              src={url}
              crossOrigin="anonymous"
              playsInline
            />
          );
        })}
      </div>
    );
  };

  const videoTracks = tracks.filter(t => !t.isAudioOnly);

  if (tracks.length === 0) {
    return (
      <div style={{ 
        display: 'flex', alignItems: 'center', justifyContent: 'center', 
        height: '100%', color: '#666', fontSize: '1.1rem' 
      }}>
        トラックを追加してください
      </div>
    );
  }

  if (videoTracks.length === 0) {
    return (
      <div 
        ref={containerRef}
        style={{ 
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', 
          height: '100%', color: '#94a3b8', fontSize: '1.1rem', background: '#05080f', borderRadius: '8px',
          position: 'relative'
        }}
      >
        {renderLayoutToggle()}
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
        <div>音声のみ再生中</div>
        
        {renderHiddenAudioPlayers()}
      </div>
    );
  }

  // ----------------------------------------------------
  // レイアウト幾何計算
  // ----------------------------------------------------
  const { width: W, height: H } = dimensions;
  const gap = 10;

  // Grid layout geometry: 列数の候補を総当たりし、プレビュー領域の寸法と
  // タイルの16:9比から実際に配置できるタイルサイズが最大になる列数を選ぶ
  // （トラック数だけから sqrt で列数を決める方式だと、領域の縦横比を無視して
  //   無駄な余白や不揃いな並びが生じやすいため）
  const N = Math.max(1, videoTracks.length);

  const gridGap = 12;
  const gridPaddingTop = 16;
  const gridPaddingBottom = 16;
  const gridPaddingLeft = 16;
  const gridPaddingRight = 16;

  let C = 1;
  let bestTileW = -Infinity;
  for (let c = 1; c <= N; c++) {
    const r = Math.ceil(N / c);
    const wAvail = Math.max(100, W - gridPaddingLeft - gridPaddingRight - (c - 1) * gridGap);
    const hAvail = Math.max(100, H - gridPaddingTop - gridPaddingBottom - (r - 1) * gridGap);
    const tileW = Math.min(wAvail / c, (hAvail / r) * (16 / 9));
    if (tileW > bestTileW) {
      bestTileW = tileW;
      C = c;
    }
  }

  const gridW = Math.max(80, bestTileW);
  const gridH = gridW / (16 / 9);

  // PiP layout geometry
  const numItems = Math.max(1, videoTracks.length);
  const maxPipHeight = H / numItems - gap;
  const maxPipWidthBasedOnHeight = (maxPipHeight * 16) / 9;

  // Final responsive width, constrained by height limit and min/max bounds
  const pipWidth = Math.max(80, Math.min(280, W * 0.20, maxPipWidthBasedOnHeight));
  const pipHeight = (pipWidth * 9) / 16;

  // Main view layout calculations (defined outside the render loop)
  const V_WIDTH = 1280;
  const V_HEIGHT = 720;
  const mainScale = W > 0 && H > 0 ? Math.min(W / V_WIDTH, H / V_HEIGHT) : 0.5;
  const mainWidth = V_WIDTH * mainScale;
  const mainHeight = V_HEIGHT * mainScale;
  const totalLetterbox = Math.max(0, W - mainWidth);
  const pipRightEdge = gap + pipWidth;
  const centeredLeft = totalLetterbox / 2;
  const mainLeft = Math.min(totalLetterbox, Math.max(centeredLeft, pipRightEdge));
  const mainTop = W > 0 && H > 0 ? (H - V_HEIGHT * mainScale) / 2 : 0;

  return (
    <div 
      ref={containerRef}
      className={isGridView ? "multicam-preview-grid" : "multicam-preview-container"} 
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        minWidth: '100%',
        minHeight: '100%',
        background: '#05080f',
        borderRadius: '8px',
        overflow: 'hidden',
        boxSizing: 'border-box',
        display: isGridView ? 'grid' : 'block',
        gridTemplateColumns: isGridView ? `repeat(${C}, ${gridW}px)` : undefined,
        gridAutoRows: isGridView ? `${gridH}px` : undefined,
        justifyContent: isGridView ? 'center' : undefined,
        alignContent: isGridView ? 'center' : undefined,
        gap: isGridView ? `${gridGap}px` : undefined,
        padding: isGridView ? '16px' : '0px'
      }}
      onContextMenu={(e) => {
        // 映像カード以外の余白（黒い領域）はメインビューと同じ右クリックメニューにする
        // （カードの onContextMenu は stopPropagation しているのでここには届かない）
        if (activeCameraId) handleTileContextMenu(e, activeCameraId, true, true);
      }}
    >
      {renderLayoutToggle()}
      {videoError && (
        <div style={{ position: 'absolute', zIndex: 100, top: '50%', left: 0, right: 0, textAlign: 'center', color: 'red', background: 'rgba(0,0,0,0.8)', padding: '10px' }}>
          {videoError}
        </div>
      )}
      
      {/* White flash overlay for dip_to_white */}
      {whiteOverlayOpacity > 0.0 && (
        <div style={{
          position: 'absolute',
          top: 0, left: 0, right: 0, bottom: 0,
          background: '#ffffff',
          opacity: whiteOverlayOpacity,
          pointerEvents: 'none',
          zIndex: 15
        }} />
      )}
      
      {videoTracks.map((track, i) => {
        const isOnAir = track.id === onAirCameraId;
        const isPreviewOverride = track.id === previewOverrideCameraId;
        const isActive = track.id === activeCameraId;
        const isPrevious = track.id === previousCameraId;
        const isMainView = isActive || isPrevious;
        
        const rawPath = track.proxyPath || track.path;
        const url = convertFileSrc(rawPath.replace(/\\/g, '/'));
        
        // Define fixed video layout size
        const V_WIDTH = 1280;
        const V_HEIGHT = 720;

        // Compute scaling and translation
        let videoStyle: React.CSSProperties;
        let trackContainerStyle: React.CSSProperties;

        const color = track.colorState || { temperature: 0, tint: 0, exposure: 0, contrast: 0 };
        const brightnessVal = 1.0 + (color.exposure / 100);
        const contrastVal = 1.0 + (color.contrast / 100);
        const filterVal = `brightness(${brightnessVal}) contrast(${contrastVal})`;

        let tempBg = 'transparent';
        if (color.temperature > 0) {
          const alpha = (color.temperature / 100) * 0.25;
          tempBg = `rgba(255, 180, 0, ${alpha})`;
        } else if (color.temperature < 0) {
          const alpha = (Math.abs(color.temperature) / 100) * 0.25;
          tempBg = `rgba(0, 100, 255, ${alpha})`;
        }

        let tintBg = 'transparent';
        if (color.tint > 0) {
          const alpha = (color.tint / 100) * 0.20;
          tintBg = `rgba(255, 0, 180, ${alpha})`;
        } else if (color.tint < 0) {
          const alpha = (Math.abs(color.tint) / 100) * 0.20;
          tintBg = `rgba(0, 255, 100, ${alpha})`;
        }

        if (isGridView) {
          let borderColor = '2px solid #1e293b';
          let boxShadow = 'none';
          if (isOnAir) {
            borderColor = '3px solid #ef4444';
            boxShadow = '0 0 12px rgba(239, 68, 68, 0.4)';
          } else if (isPreviewOverride) {
            borderColor = '3px solid #3b82f6';
            boxShadow = '0 0 12px rgba(59, 130, 246, 0.4)';
          }
          trackContainerStyle = {
            position: 'relative',
            border: borderColor,
            borderRadius: '6px',
            overflow: 'hidden',
            background: '#000',
            cursor: 'pointer',
            boxShadow: boxShadow,
            transition: 'all 0.2s ease-in-out',
            width: `${gridW}px`,
            height: `${gridH}px`
          };

          videoStyle = {
            position: 'relative',
            zIndex: 1,
            width: '100%',
            height: '100%',
            objectFit: 'contain',
            filter: filterVal
          };
        } else {
           // PiP view container styles
          trackContainerStyle = isMainView ? {
            position: 'absolute',
            top: `${mainTop}px`,
            left: `${mainLeft}px`,
            width: `${mainWidth}px`,
            height: `${mainHeight}px`,
            zIndex: isMainView ? (isActive ? 10 : 9) : 20,
            opacity: isMainView ? (
              previousCameraId !== null ? (
                activeTransition === 'crossfade' ? (isActive ? transitionProgress : 1.0) : (
                  activeTransition === 'dip_to_black' ? (isActive ? (transitionProgress < 0.5 ? 0.0 : (transitionProgress - 0.5) * 2) : (transitionProgress < 0.5 ? 1.0 - (transitionProgress * 2) : 0.0)) : (
                    activeTransition === 'dip_to_white' ? (isActive ? (transitionProgress < 0.5 ? 0.0 : 1.0) : (transitionProgress < 0.5 ? 1.0 : 0.0)) : 1.0
                  )
                )
              ) : 1.0
            ) : 1.0,
            background: '#000',
            overflow: 'hidden',
            border: '2px solid #333',
            boxSizing: 'border-box',
            borderRadius: '8px'
          } : {
            position: 'absolute',
            top: `${i * (pipHeight + gap) + gap}px`,
            left: `${gap}px`,
            width: `${pipWidth}px`,
            height: `${pipHeight}px`,
            zIndex: 20,
            cursor: 'pointer',
            border: '2px solid #333',
            borderRadius: '6px',
            overflow: 'hidden',
            background: '#000',
            boxShadow: '0 4px 6px rgba(0,0,0,0.5)'
          };

          // Apply export range opacity adjustments in main view
          if (isMainView && isActive && exportRange?.useRange) {
            let overlayOpacity = 1.0;
            if (exportRange.fadeIn && exportRange.fadeInDuration) {
              const start = exportRange.start;
              const dur = exportRange.fadeInDuration;
              if (currentTime >= start && currentTime < start + dur) {
                overlayOpacity *= (currentTime - start) / dur;
              }
            }
            if (exportRange.fadeOut && exportRange.fadeOutDuration) {
              const end = exportRange.end;
              const dur = exportRange.fadeOutDuration;
              if (currentTime > end - dur && currentTime <= end) {
                overlayOpacity *= (end - currentTime) / dur;
              }
            }
            trackContainerStyle.opacity = (Number(trackContainerStyle.opacity ?? 1.0) * overlayOpacity);
          }

          if (isMainView) {
            videoStyle = {
              position: 'relative',
              zIndex: 1,
              width: '100%',
              height: '100%',
              objectFit: 'contain',
              filter: filterVal
            };
          } else {
            videoStyle = {
              position: 'absolute',
              top: 0,
              left: 0,
              width: `${V_WIDTH}px`,
              height: `${V_HEIGHT}px`,
              transform: `scale(${pipWidth / V_WIDTH})`,
              transformOrigin: 'top left',
              objectFit: 'contain',
              maxWidth: 'none',
              maxHeight: 'none',
              filter: filterVal
            };
          }
        }

        const overlayStyle: React.CSSProperties = {
          ...videoStyle,
          position: 'absolute',
          top: videoStyle.position === 'absolute' ? videoStyle.top : 0,
          left: videoStyle.position === 'absolute' ? videoStyle.left : 0,
          width: videoStyle.width,
          height: videoStyle.height,
          transform: videoStyle.transform,
          transformOrigin: videoStyle.transformOrigin,
          objectFit: videoStyle.objectFit,
          pointerEvents: 'none',
          zIndex: 5,
          mixBlendMode: 'overlay' as any
        };

        return (
          <React.Fragment key={track.id}>
            {/* Stable Single Video container and element (No unmount/remount on view switch) */}
            <div 
              style={trackContainerStyle} 
              className={isGridView ? "grid-video-container" : ((!isMainView) ? "pip-video-container" : undefined)}
              onClick={isGridView ? () => onAngleChangeRequested(track.id) : ((!isMainView) ? () => onAngleChangeRequested(track.id) : undefined)}
              onDoubleClick={isGridView ? () => onForceAddCut?.(track.id) : ((!isMainView) ? () => onForceAddCut?.(track.id) : undefined)}
              onContextMenu={(e) => handleTileContextMenu(e, track.id, !isGridView && isMainView)}
            >
              <video
                ref={el => { videoRefs.current[track.id] = el; }}
                src={url}
                crossOrigin="anonymous"
                playsInline
                muted={true}
                onError={(e) => {
                  const target = e.target as HTMLVideoElement;
                  console.error("Video load error:", target.error);
                  setVideoError(`Video load error (Code ${target.error?.code}): ${track.name}`);
                }}
                style={videoStyle}
              />

              {/* Color overlay layers */}
              {tempBg !== 'transparent' && (
                <div style={{ ...overlayStyle, backgroundColor: tempBg }} />
              )}
              {tintBg !== 'transparent' && (
                <div style={{ ...overlayStyle, backgroundColor: tintBg }} />
              )}

              {/* Hover Cut Add Button (Scissors icon) */}
              {((isGridView || !isMainView) && track.id !== onAirCameraId) && (
                <button 
                  className="preview-cut-add-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    onForceAddCut?.(track.id);
                  }}
                  title="この位置にカットを追加 (ダブルクリックでも可)"
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="6" cy="6" r="3"></circle>
                    <circle cx="6" cy="18" r="3"></circle>
                    <line x1="20" y1="4" x2="8.12" y2="15.88"></line>
                    <line x1="14.47" y1="14.48" x2="20" y2="20"></line>
                    <line x1="8.12" y1="8.12" x2="12" y2="12"></line>
                  </svg>
                </button>
              )}
              
              {isGridView ? (
                <>
                  {/* Grid View Badges */}
                  {(isOnAir || isPreviewOverride) && (
                    <div style={{
                      position: 'absolute',
                      bottom: 6,
                      right: 6,
                      background: isOnAir ? '#ef4444' : '#3b82f6',
                      color: 'white',
                      padding: '2px 6px',
                      borderRadius: '4px',
                      fontSize: '0.65rem',
                      fontWeight: 'bold',
                      pointerEvents: 'none',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '4px',
                      boxShadow: '0 2px 4px rgba(0,0,0,0.5)',
                      zIndex: 10
                    }}>
                      <span className="status-dot processing" style={{ backgroundColor: '#fff', width: '4px', height: '4px', filter: 'none' }} />
                      {isOnAir ? 'TIMELINE' : 'PREVIEW'}
                    </div>
                  )}

                  <div style={{
                    position: 'absolute',
                    bottom: 6,
                    left: 6,
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    background: track.isRef ? '#4ade80' : 'rgba(0,0,0,0.7)',
                    color: track.isRef ? '#052e16' : 'white',
                    padding: '2px 8px',
                    borderRadius: '4px',
                    fontSize: '0.75rem',
                    fontWeight: 'bold',
                    pointerEvents: 'none',
                    zIndex: 10
                  }}>
                    {!track.isRef && (
                      <span style={{ display: 'inline-block', width: '3px', height: '11px', background: getTrackColor(track, tracks), borderRadius: '1px', flexShrink: 0 }} />
                    )}
                    {track.name}
                  </div>
                </>
              ) : (
                <>

                  {/* ON AIR Badge overlay on playing thumbnail when preview is overridden (only in thumbnail mode) */}
                  {!isMainView && track.id === onAirCameraId && (
                    <div style={{
                      position: 'absolute',
                      top: 6,
                      right: 6,
                      background: '#ef4444',
                      color: 'white',
                      padding: '2px 6px',
                      borderRadius: '4px',
                      fontSize: '0.65rem',
                      fontWeight: 'bold',
                      pointerEvents: 'none',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '4px',
                      boxShadow: '0 2px 4px rgba(0,0,0,0.5)',
                      zIndex: 22
                    }}>
                      <span className="status-dot processing" style={{ backgroundColor: '#fff', width: '4px', height: '4px', filter: 'none' }} />
                      TIMELINE
                    </div>
                  )}

                  {/* サムネイル（PiP）の左下にトラック名ラベル */}
                  {!isMainView && (
                    <div style={{
                      position: 'absolute',
                      bottom: 4,
                      left: 4,
                      display: 'flex',
                      alignItems: 'center',
                      gap: '5px',
                      background: track.isRef ? '#4ade80' : 'rgba(0,0,0,0.7)',
                      color: track.isRef ? '#052e16' : 'white',
                      padding: '2px 6px',
                      borderRadius: '4px',
                      fontSize: '0.7rem',
                      fontWeight: 'bold',
                      pointerEvents: 'none',
                      zIndex: 23
                    }}>
                      {!track.isRef && (
                        <span style={{ display: 'inline-block', width: '3px', height: '10px', background: getTrackColor(track, tracks), borderRadius: '1px', flexShrink: 0 }} />
                      )}
                      {track.name}
                    </div>
                  )}

                  {!isMainView && (
                    <div style={{
                      position: 'absolute',
                      top: 0, left: 0, right: 0, bottom: 0,
                      background: 'rgba(255,255,255,0)',
                      transition: 'background 0.2s',
                      pointerEvents: 'none',
                    }} className="pip-hover-overlay" />
                  )}
                </>
              )}
            </div>

            {/* Placeholder Card at the PiP list position when the track is in full-screen (Main View) - Only in PiP View */}
            {!isGridView && isMainView && (
              <div 
                style={{
                  position: 'absolute',
                  top: `${i * (pipHeight + gap) + gap}px`,
                  left: `${gap}px`,
                  width: `${pipWidth}px`,
                  height: `${pipHeight}px`,
                  zIndex: 20,
                  border: track.id === onAirCameraId ? '2px solid #ef4444' : '2px solid #3b82f6',
                  borderRadius: '6px',
                  overflow: 'hidden',
                  background: track.id === onAirCameraId ? 'rgba(239, 68, 68, 0.12)' : 'rgba(59, 130, 246, 0.12)',
                  boxShadow: '0 4px 6px rgba(0,0,0,0.5)',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  userSelect: 'none',
                  cursor: track.id !== onAirCameraId ? 'pointer' : 'default'
                }}
                className="pip-video-container"
                onDoubleClick={track.id !== onAirCameraId ? () => onForceAddCut?.(track.id) : undefined}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  {track.id === onAirCameraId ? (
                    <>
                      <span className="status-dot processing" style={{ backgroundColor: '#ef4444', boxShadow: '0 0 8px #ef4444aa', width: '6px', height: '6px' }} />
                      <span style={{ color: '#ef4444', fontSize: '0.65rem', fontWeight: 'bold', letterSpacing: '0.05em' }}>TIMELINE</span>
                    </>
                  ) : (
                    <>
                      <span className="status-dot processing" style={{ backgroundColor: '#3b82f6', boxShadow: '0 0 8px #3b82f6aa', width: '6px', height: '6px' }} />
                      <span style={{ color: '#3b82f6', fontSize: '0.65rem', fontWeight: 'bold', letterSpacing: '0.05em' }}>PREVIEW</span>
                    </>
                  )}
                </div>

                {/* Hover Cut Add Button on Previewing Placeholder Card */}
                {(track.id !== onAirCameraId) && (
                  <button 
                    className="preview-cut-add-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      onForceAddCut?.(track.id);
                    }}
                    title="この位置にカットを追加 (ダブルクリックでも可)"
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="6" cy="6" r="3"></circle>
                      <circle cx="6" cy="18" r="3"></circle>
                      <line x1="20" y1="4" x2="8.12" y2="15.88"></line>
                      <line x1="14.47" y1="14.48" x2="20" y2="20"></line>
                      <line x1="8.12" y1="8.12" x2="12" y2="12"></line>
                    </svg>
                  </button>
                )}

                <div style={{
                  position: 'absolute',
                  bottom: 4,
                  left: 4,
                  display: 'flex',
                  alignItems: 'center',
                  gap: '5px',
                  background: track.isRef ? '#4ade80' : 'rgba(0,0,0,0.7)',
                  color: track.isRef ? '#052e16' : 'white',
                  padding: '2px 6px',
                  borderRadius: '4px',
                  fontSize: '0.7rem',
                  fontWeight: 'bold',
                }}>
                  {!track.isRef && (
                    <span style={{ display: 'inline-block', width: '3px', height: '10px', background: getTrackColor(track, tracks), borderRadius: '1px', flexShrink: 0 }} />
                  )}
                  {track.name}
                </div>
              </div>
            )}
          </React.Fragment>
        );
      })}
      {renderHiddenAudioPlayers()}

      {contextMenu && (() => {
        const menuTrack = tracks.find(t => t.id === contextMenu.cameraId);
        if (!menuTrack) return null;
        const isOnAirCam = contextMenu.cameraId === onAirCameraId;
        const isActiveCam = contextMenu.cameraId === activeCameraId;

        const itemStyle = (disabled?: boolean): React.CSSProperties => ({
          width: '100%',
          padding: '6px 12px',
          background: 'transparent',
          border: 'none',
          color: disabled ? '#64748b' : '#e2e8f0',
          textAlign: 'left',
          cursor: disabled ? 'default' : 'pointer',
          fontSize: '0.75rem'
        });
        const onEnter = (disabled?: boolean) => (e: React.MouseEvent<HTMLButtonElement>) => {
          if (!disabled) e.currentTarget.style.background = 'rgba(255,255,255,0.08)';
        };
        const onLeave = (e: React.MouseEvent<HTMLButtonElement>) => {
          e.currentTarget.style.background = 'transparent';
        };
        const divider = <div style={{ borderTop: '1px solid #334155', margin: '4px 0' }} />;

        return (
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
              width: '220px',
              userSelect: 'none'
            }}
            onClick={e => e.stopPropagation()}
            onContextMenu={e => e.preventDefault()}
          >
            {!contextMenu.isEmptyArea && (
              <div style={{ padding: '4px 12px', fontSize: '0.65rem', color: '#94a3b8', borderBottom: '1px solid #334155', marginBottom: '4px', fontFamily: 'monospace' }}>
                {menuTrack.name}
              </div>
            )}

            {contextMenu.isMainView ? (
              <>
                <button
                  onClick={() => { onSetExportStart?.(); setContextMenu(null); }}
                  style={itemStyle()}
                  onMouseEnter={onEnter()}
                  onMouseLeave={onLeave}
                >
                  IN点を現在位置に設定
                </button>
                <button
                  onClick={() => { onSetExportEnd?.(); setContextMenu(null); }}
                  style={itemStyle()}
                  onMouseEnter={onEnter()}
                  onMouseLeave={onLeave}
                >
                  OUT点を現在位置に設定
                </button>

                {divider}
                <button
                  disabled={previewOverrideCameraId === null}
                  onClick={() => { if (previewOverrideCameraId !== null) { onClearPreviewOverride?.(); setContextMenu(null); } }}
                  style={itemStyle(previewOverrideCameraId === null)}
                  onMouseEnter={onEnter(previewOverrideCameraId === null)}
                  onMouseLeave={onLeave}
                >
                  タイムライン追従に戻る
                </button>

                {divider}
                <button
                  onClick={() => { onToggleGridView?.(); setContextMenu(null); }}
                  style={itemStyle()}
                  onMouseEnter={onEnter()}
                  onMouseLeave={onLeave}
                >
                  {isGridView ? 'プレビュー表示に切り替え' : 'グリッド表示に切り替え'}
                </button>
              </>
            ) : (
              <>
                <button
                  disabled={isActiveCam}
                  onClick={() => { if (!isActiveCam) { onAngleChangeRequested(contextMenu.cameraId); setContextMenu(null); } }}
                  style={itemStyle(isActiveCam)}
                  onMouseEnter={onEnter(isActiveCam)}
                  onMouseLeave={onLeave}
                >
                  このカメラをプレビュー
                </button>
                <button
                  disabled={isOnAirCam}
                  onClick={() => { if (!isOnAirCam) { onForceAddCut?.(contextMenu.cameraId); setContextMenu(null); } }}
                  style={itemStyle(isOnAirCam)}
                  onMouseEnter={onEnter(isOnAirCam)}
                  onMouseLeave={onLeave}
                >
                  ここでカットして切り替え
                </button>
                {divider}
                <button
                  onClick={() => { onSetExportStart?.(); setContextMenu(null); }}
                  style={itemStyle()}
                  onMouseEnter={onEnter()}
                  onMouseLeave={onLeave}
                >
                  IN点を現在位置に設定
                </button>
                <button
                  onClick={() => { onSetExportEnd?.(); setContextMenu(null); }}
                  style={itemStyle()}
                  onMouseEnter={onEnter()}
                  onMouseLeave={onLeave}
                >
                  OUT点を現在位置に設定
                </button>
              </>
            )}
          </div>
        );
      })()}
    </div>
  );
}
