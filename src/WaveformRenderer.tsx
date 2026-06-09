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
    
    let animationId: number;

    const draw = () => {
      // リアルタイムにコンテナの幅と高さを取得
      const containerWidth = scrollContainerRef?.current?.clientWidth || canvas.parentElement?.clientWidth || 1000;
      const containerHeight = localContainerRef.current?.clientHeight || canvas.parentElement?.clientHeight || 55;

      const waveWidth = containerWidth;

      if (canvas.width !== waveWidth || canvas.height !== containerHeight) {
        canvas.width = waveWidth;
        canvas.height = containerHeight;
      }

      const scrollLeft = scrollContainerRef?.current?.scrollLeft || 0;
      
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
      
      animationId = requestAnimationFrame(draw);
    };

    animationId = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(animationId);
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
        {offsetSeconds > 0 ? '+' : ''}{offsetSeconds.toFixed(3)}s
      </div>
    </div>
  );
}
