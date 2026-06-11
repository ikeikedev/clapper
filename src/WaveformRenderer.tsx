import { useEffect, useRef } from 'react';

interface WaveformRendererProps {
  peaks: number[];
  pixelsPerSecond: number;
  offsetSeconds: number;
  color?: string;
  width?: number;
  scrollContainerRef?: React.RefObject<HTMLDivElement | null>;
}

export function WaveformRenderer({
  peaks,
  pixelsPerSecond,
  offsetSeconds,
  color = '#3b82f6',
  scrollContainerRef
}: WaveformRendererProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const localContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || peaks.length === 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animationId: number | null = null;
    // ダーティチェック: 前回描画時からスクロール位置・サイズが変わらないフレームは
    // 再描画をスキップする（アイドル時のCPU浪費防止）。props（peaks/zoom/offset/color）の
    // 変更はこの useEffect 自体が再実行されるので、初期値 -1 により必ず1回描画される。
    let lastScrollLeft = -1;
    let lastWidth = -1;
    let lastHeight = -1;

    const draw = () => {
      animationId = requestAnimationFrame(draw);

      // リアルタイムにコンテナの幅と高さを取得
      const containerWidth = scrollContainerRef?.current?.clientWidth || canvas.parentElement?.clientWidth || 1000;
      const containerHeight = localContainerRef.current?.clientHeight || canvas.parentElement?.clientHeight || 55;
      const scrollLeft = scrollContainerRef?.current?.scrollLeft || 0;

      if (scrollLeft === lastScrollLeft && containerWidth === lastWidth && containerHeight === lastHeight) return;
      lastScrollLeft = scrollLeft;
      lastWidth = containerWidth;
      lastHeight = containerHeight;

      const waveWidth = containerWidth;

      if (canvas.width !== waveWidth || canvas.height !== containerHeight) {
        canvas.width = waveWidth;
        canvas.height = containerHeight;
      }

      ctx.clearRect(0, 0, canvas.width, canvas.height);

      const middleY = containerHeight / 2;

      // センターライン
      ctx.fillStyle = '#333333';
      ctx.fillRect(0, middleY, canvas.width, 1);

      ctx.fillStyle = color;

      // 表示範囲のみを描画
      const visibleStartPixel = scrollLeft;
      const visibleEndPixel = visibleStartPixel + waveWidth;

      const offsetPixels = offsetSeconds * pixelsPerSecond;
      const pointsPerSecond = 50;
      const pixelsPerPoint = pixelsPerSecond / pointsPerSecond;
      const barWidth = Math.max(1, Math.floor(pixelsPerPoint));

      const startPointIndex = Math.floor((visibleStartPixel - offsetPixels) / pixelsPerPoint);
      const endPointIndex = Math.ceil((visibleEndPixel - offsetPixels) / pixelsPerPoint);

      const clampedStart = Math.max(0, startPointIndex - 10);
      const clampedEnd = Math.min(peaks.length, endPointIndex + 10);

      const step = Math.max(1, Math.floor(1 / pixelsPerPoint));

      for (let i = clampedStart; i < clampedEnd; i += step) {
        let maxPeak = peaks[i];
        if (step > 1) {
          for (let j = 1; j < step && i + j < clampedEnd; j++) {
            if (peaks[i + j] > maxPeak) maxPeak = peaks[i + j];
          }
        }

        const barHeight = maxPeak * (middleY * 0.9);

        // 絶対座標
        const absX = (i * pixelsPerPoint) + offsetPixels;

        // ビューポート相対座標に変換して描画
        const drawX = absX - visibleStartPixel;

        ctx.fillRect(drawX, middleY - barHeight, barWidth, barHeight);
        ctx.fillRect(drawX, middleY, barWidth, barHeight);
      }
    };

    const startLoop = () => {
      if (animationId === null) {
        lastScrollLeft = -1; // 再開時は必ず1回描画する
        animationId = requestAnimationFrame(draw);
      }
    };
    const stopLoop = () => {
      if (animationId !== null) {
        cancelAnimationFrame(animationId);
        animationId = null;
      }
    };

    // 縦カリング: トラック行が縦スクロールで画面外にある間は描画ループ自体を止める。
    // IntersectionObserver は祖先要素の overflow クリップも考慮するため root 指定は不要。
    const observer = new IntersectionObserver(entries => {
      if (entries[entries.length - 1].isIntersecting) startLoop();
      else stopLoop();
    });
    observer.observe(localContainerRef.current ?? canvas);

    startLoop();

    return () => {
      stopLoop();
      observer.disconnect();
    };
  }, [peaks, pixelsPerSecond, offsetSeconds, color, scrollContainerRef]);

  return (
    <div ref={localContainerRef} className="waveform-container" style={{
      border: '1px solid rgba(255, 255, 255, 0.1)', 
      background: 'rgba(0, 0, 0, 0.3)', 
      borderRadius: '8px',
      boxShadow: 'inset 0 2px 10px rgba(0, 0, 0, 0.5)',
      position: 'absolute',
      top: 0, bottom: 0, left: 0, right: 0,
      pointerEvents: 'none'
    }}>
      {peaks.length === 0 ? (
        <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#666' }}>
          波形データがありません
        </div>
      ) : (
        <canvas 
          ref={canvasRef} 
          style={{ 
            position: 'sticky', 
            left: 0,
            top: 0,
            height: '100%',
            pointerEvents: 'none'
          }} 
        />
      )}
      
      <div 
        className="waveform-offset-badge"
        style={{
          position: 'absolute',
          top: 5,
          left: Math.max(0, offsetSeconds * pixelsPerSecond) + 10,
          background: 'rgba(0,0,0,0.8)',
          padding: '2px 8px',
          borderRadius: 4,
          fontSize: '0.8rem',
          color: '#fff',
          fontWeight: 'bold',
          border: `1px solid ${color}`,
          display: offsetSeconds === 0 ? 'none' : 'block'
        }}
      >
        {`${offsetSeconds > 0 ? '+' : ''}${offsetSeconds.toFixed(3)}s`}
      </div>
    </div>
  );
}
