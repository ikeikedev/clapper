import { useEffect, useRef } from 'react';
import { audioEngine } from './AudioEngine';

export function VolumeMeter() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let animId: number;
    const draw = () => {
      const vol = audioEngine.getMeterLevel();
      const ctx = canvasRef.current?.getContext('2d');
      if (ctx && canvasRef.current) {
        const width = canvasRef.current.width;
        const height = canvasRef.current.height;
        
        ctx.clearRect(0, 0, width, height);
        ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
        ctx.fillRect(0, 0, width, height);
        
        // Color gradient: Green -> Yellow -> Red
        const gradient = ctx.createLinearGradient(0, height, 0, 0);
        gradient.addColorStop(0, '#4ade80');
        gradient.addColorStop(0.7, '#eab308');
        gradient.addColorStop(1, '#ef4444');
        
        ctx.fillStyle = gradient;
        
        // Logarithmic visual scaling
        const visualHeight = Math.pow(vol, 0.7) * height;
        ctx.fillRect(0, height - visualHeight, width, visualHeight);
        
        // Draw grid lines
        ctx.fillStyle = 'rgba(255, 255, 255, 0.2)';
        for (let i = 1; i < 4; i++) {
          ctx.fillRect(0, height * (i / 4), width, 1);
        }
      }
      animId = requestAnimationFrame(draw);
    };
    animId = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(animId);
  }, []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px' }}>
      <canvas ref={canvasRef} width={20} height={120} style={{ borderRadius: 4, border: '1px solid #333' }} />
      <span style={{ fontSize: '10px', color: '#94a3b8' }}>MASTER</span>
    </div>
  );
}
