import React, { useRef, useEffect, useState, useCallback } from 'react';
import type { TrackData, TrackAudioState, MasterAudioState, EQState, CompState } from './types';
import { audioEngine, DEFAULT_COMP, DEFAULT_EQ, EQ_BANDS } from './AudioEngine';
import { getTrackColor } from './Timeline';

// ── Helpers ──────────────────────────────────────────────────────────────────

function clamp(v: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, v)); }

// ── VU Meter ─────────────────────────────────────────────────────────────────

// RMS値(0~1.0)をメーター表示位置(0~1.0)に変換
// dBFS基準: 0dBFS = RMS 1.0, -60dB = RMS 0.001
// 表示範囲: -60dBFS ~ 0dBFS を 0% ~ 100% にマッピング
const DB_FLOOR = -60; // 最低表示dB
function toMeterPos(rms: number): number {
  if (rms <= 0) return 0;
  const db = 20 * Math.log10(rms); // RMS -> dB変換
  const clamped = Math.max(DB_FLOOR, Math.min(0, db));
  return (clamped - DB_FLOOR) / (-DB_FLOOR); // 0~1に正規化
}

function VUMeter({ getLevel, width = 24 }: { getLevel: () => { l: number, r: number }; width?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number>(0);
  const peakLRef = useRef(0);
  const peakRRef = useRef(0);
  const peakDecayLRef = useRef(0);
  const peakDecayRRef = useRef(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;

    const draw = () => {
      // Dynamic resize
      const parent = canvas.parentElement;
      if (parent) {
        const targetH = parent.clientHeight;
        if (canvas.height !== targetH) {
          canvas.height = targetH;
        }
      }
      
      const W = canvas.width;
      const H = canvas.height;

      const { l, r } = getLevel();
      if (l > peakLRef.current) { peakLRef.current = l; peakDecayLRef.current = 60; }
      else if (peakDecayLRef.current > 0) peakDecayLRef.current--;
      else peakLRef.current = Math.max(0, peakLRef.current - 0.002);
      
      if (r > peakRRef.current) { peakRRef.current = r; peakDecayRRef.current = 60; }
      else if (peakDecayRRef.current > 0) peakDecayRRef.current--;
      else peakRRef.current = Math.max(0, peakRRef.current - 0.002);

      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = '#0f172a';
      ctx.fillRect(0, 0, W, H);

      const grad = ctx.createLinearGradient(0, H, 0, 0);
      grad.addColorStop(0, '#22c55e');
      grad.addColorStop(0.7, '#eab308');
      grad.addColorStop(1, '#ef4444');
      ctx.fillStyle = grad;

      const scaledL = toMeterPos(l);
      const scaledR = toMeterPos(r);
      const barHL = scaledL * H;
      const barHR = scaledR * H;
      const barWidth = (W / 2) - 1;
      ctx.fillRect(0, H - barHL, barWidth, barHL);
      ctx.fillRect(barWidth + 2, H - barHR, barWidth, barHR);

      const scaledPeakL = toMeterPos(peakLRef.current);
      const scaledPeakR = toMeterPos(peakRRef.current);
      const peakYL = H - scaledPeakL * H;
      const peakYR = H - scaledPeakR * H;
      // RMSで0.7超 = -3dBFS相当 → クリッピング警告
      ctx.fillStyle = peakLRef.current > 0.7 ? '#ef4444' : '#fff';
      ctx.fillRect(0, peakYL, barWidth, 2);
      ctx.fillStyle = peakRRef.current > 0.7 ? '#ef4444' : '#fff';
      ctx.fillRect(barWidth + 2, peakYR, barWidth, 2);


      rafRef.current = requestAnimationFrame(draw);
    };
    rafRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafRef.current);
  }, [getLevel]);

  return (
    <canvas
      ref={canvasRef}
      width={width}
      height={250} // Initial height, resized by JS
      style={{ display: 'block', borderRadius: 4, border: '1px solid #1e293b', boxSizing: 'border-box', height: '100%' }}
    />
  );
}

// ── GR Meter ─────────────────────────────────────────────────────────────────

function GRMeter({ getGR }: { getGR: () => number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    const W = canvas.width;
    const H = canvas.height;
    const MAX_GR = 20;

    const draw = () => {
      const gr = clamp(getGR(), 0, MAX_GR);
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = '#0f172a';
      ctx.fillRect(0, 0, W, H);
      if (gr > 0) {
        const barW = (gr / MAX_GR) * W;
        const grad = ctx.createLinearGradient(0, 0, W, 0);
        grad.addColorStop(0, '#eab308');
        grad.addColorStop(1, '#ef4444');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, barW, H);
      }
      rafRef.current = requestAnimationFrame(draw);
    };
    rafRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafRef.current);
  }, [getGR]);

  return (
    <canvas
      ref={canvasRef}
      width={120}
      height={10}
      style={{ display: 'block', borderRadius: 3 }}
    />
  );
}

// ── Power Toggle (電源アイコン) ────────────────────────────────────────────────

function PowerToggle({ enabled, onToggle, color }: { enabled: boolean; onToggle: () => void; color: string }) {
  // 基準スタイル（ホバー解除時に戻す値）
  const baseBg = enabled ? `${color}26` : 'rgba(255,255,255,0.04)';
  const baseBorder = enabled ? color : '#475569';
  const baseColor = enabled ? color : '#64748b';
  const hoverBg = enabled ? `${color}40` : 'rgba(255,255,255,0.10)';
  const hoverBorder = enabled ? color : '#64748b';
  const hoverColor = enabled ? color : '#94a3b8';
  return (
    <button
      onClick={onToggle}
      title={enabled ? 'クリックでバイパス（オフ）' : 'クリックで有効化（オン）'}
      onMouseEnter={e => {
        e.currentTarget.style.background = hoverBg;
        e.currentTarget.style.borderColor = hoverBorder;
        e.currentTarget.style.color = hoverColor;
      }}
      onMouseLeave={e => {
        e.currentTarget.style.background = baseBg;
        e.currentTarget.style.borderColor = baseBorder;
        e.currentTarget.style.color = baseColor;
      }}
      style={{
        width: 28, height: 28, borderRadius: '50%',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: baseBg,
        border: `1.5px solid ${baseBorder}`,
        color: baseColor,
        cursor: 'pointer', padding: 0, flexShrink: 0,
        transition: 'all 0.15s',
      }}
    >
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M18.36 6.64a9 9 0 1 1-12.73 0" />
        <line x1="12" y1="2" x2="12" y2="12" />
      </svg>
    </button>
  );
}

// ── EQ Section ───────────────────────────────────────────────────────────────

function EQSection({ eq, enabled, onChange, onToggleEnabled }: {
  eq: EQState;
  enabled: boolean;
  onChange: (eq: EQState) => void;
  onToggleEnabled: () => void;
}) {
  // 1バンドだけ変更した新しい配列を返す
  const withBand = (i: number, val: number) => EQ_BANDS.map((_, idx) => idx === i ? val : (eq[idx] ?? 0));
  const resetAll = () => onChange([...DEFAULT_EQ]);
  const btnBase: React.CSSProperties = {
    height: 22, padding: '0 8px', border: 'none', borderRadius: 4,
    fontSize: '0.72rem', fontWeight: 'bold', cursor: 'pointer'
  };
  return (
    <div>
      {/* ヘッダー: 電源トグル(左) と RESET(右) を離して配置 */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 20px 0' }}>
        <PowerToggle enabled={enabled} onToggle={onToggleEnabled} color="#3b82f6" />
        <button
          onClick={resetAll}
          style={{ ...btnBase, background: 'rgba(255,255,255,0.08)', color: '#94a3b8' }}
          title="全バンドを0dBにリセット"
        >RESET</button>
      </div>
      {/* バンドスライダー */}
      <div style={{ display: 'flex', gap: 10, justifyContent: 'center', padding: '12px 16px 20px', opacity: enabled ? 1 : 0.4, pointerEvents: enabled ? 'auto' : 'none' }}>
        {EQ_BANDS.map((band, i) => {
          const v = eq[i] ?? 0;
          const display = v === 0 ? '0' : (v > 0 ? `+${Math.round(v)}` : `${Math.round(v)}`);
          const isActive = v !== 0;
          const unit = band.freq >= 1000 ? `${band.freq / 1000}k` : `${band.freq}`;
          return (
            <div key={band.freq} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: '0.76rem', fontWeight: 'bold', color: isActive ? '#60a5fa' : '#64748b', minHeight: '1.1em', lineHeight: 1 }}>
                {display}
              </span>
              <input
                type="range"
                orient="vertical"
                min={-15} max={15} step={0.5}
                value={v}
                onChange={e => onChange(withBand(i, parseFloat(e.target.value)))}
                onDoubleClick={() => onChange(withBand(i, 0))}
                onClick={e => { if (e.ctrlKey) onChange(withBand(i, 0)); }}
                className="eq-fader"
                style={{
                  writingMode: 'vertical-lr',
                  direction: 'rtl',
                  ['--fader-color' as any]: isActive ? '#3b82f6' : '#475569',
                  ['--percent' as any]: `${((v + 15) / 30 * 100)}%`
                }}
              />
              <span style={{ fontSize: '0.7rem', color: '#94a3b8', whiteSpace: 'nowrap' }}>{unit}</span>
              <span style={{ fontSize: '0.62rem', color: '#64748b' }}>
                {band.type === 'lowshelf' ? 'LO' : band.type === 'highshelf' ? 'HI' : 'Hz'}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Comp Section ─────────────────────────────────────────────────────────────

function CompSection({ comp, enabled, getGR, onChange, onToggleEnabled }: {
  comp: CompState;
  enabled: boolean;
  getGR: () => number;
  onChange: (comp: CompState) => void;
  onToggleEnabled: () => void;
}) {
  const row = (label: string, value: number, min: number, max: number, step: number, unit: string, key: keyof CompState, fmt?: (v: number) => string) => {
    const handleReset = () => onChange({ ...comp, [key]: DEFAULT_COMP[key] });
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '4px 0' }}>
        <span style={{ width: 80, fontSize: '0.8rem', color: '#94a3b8', textAlign: 'right', fontWeight: 'bold' }}>{label}</span>
        <input
          type="range" min={min} max={max} step={step} value={value}
          onChange={e => onChange({ ...comp, [key]: parseFloat(e.target.value) })}
          onDoubleClick={handleReset}
          onClick={e => { if (e.ctrlKey) handleReset(); }}
          style={{ flex: 1, accentColor: '#8b5cf6', cursor: 'pointer' }}
        />
        <span style={{ width: 60, fontSize: '0.8rem', color: '#e2e8f0', textAlign: 'left', fontFamily: 'monospace' }}>
          {fmt ? fmt(value) : `${value}${unit}`}
        </span>
      </div>
    );
  };

  const btnBase: React.CSSProperties = {
    height: 22, padding: '0 8px', border: 'none', borderRadius: 4,
    fontSize: '0.72rem', fontWeight: 'bold', cursor: 'pointer'
  };
  return (
    <div style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: 12, minWidth: 350 }}>
      {/* ヘッダー: 電源トグル(左) と RESET(右) を離して配置 */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
        <PowerToggle enabled={enabled} onToggle={onToggleEnabled} color="#8b5cf6" />
        <button
          onClick={() => onChange({ ...DEFAULT_COMP })}
          style={{ ...btnBase, background: 'rgba(255,255,255,0.08)', color: '#94a3b8' }}
          title="コンプをデフォルト値にリセット"
        >RESET</button>
      </div>
      <div style={{ opacity: enabled ? 1 : 0.4, pointerEvents: enabled ? 'auto' : 'none' }}>
        {row('Threshold', comp.threshold, -60, 0, 1, 'dB', 'threshold', v => `${v}dB`)}
        {row('Ratio',     comp.ratio,     1,   20, 0.5, ':1', 'ratio',     v => `${v}:1`)}
        {row('Attack',    comp.attack,    0.0, 1.0, 0.001, 's', 'attack',  v => `${(v * 1000).toFixed(0)}ms`)}
        {row('Release',   comp.release,   0.0, 2.0, 0.01,  's', 'release', v => `${(v * 1000).toFixed(0)}ms`)}
        {row('Knee',      comp.knee,      0,   40,  1,    'dB', 'knee',    v => `${v}dB`)}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px', background: 'rgba(0,0,0,0.3)', borderRadius: 8 }}>
        <span style={{ width: 80, fontSize: '0.8rem', color: '#ef4444', textAlign: 'right', fontWeight: 'bold' }}>GR METER</span>
        <GRMeter getGR={getGR} />
      </div>
    </div>
  );
}

// ── Floating Effect Window ────────────────────────────────────────────────────

function EffectWindow({ 
  title, 
  type, 
  state, 
  getGRLevel, 
  onChange, 
  onClose 
}: {
  title: string;
  type: 'eq' | 'comp';
  state: TrackAudioState | MasterAudioState;
  getGRLevel: () => number;
  onChange: (s: any) => void;
  onClose: () => void;
}) {
  const [pos, setPos] = useState({ x: window.innerWidth / 2 - 200, y: window.innerHeight / 2 - 150 });
  const dragRef = useRef<{ startX: number; startY: number; startPosX: number; startPosY: number } | null>(null);

  const handlePointerDown = (e: React.PointerEvent) => {
    const t = e.currentTarget as HTMLDivElement;
    t.setPointerCapture(e.pointerId);
    dragRef.current = { startX: e.clientX, startY: e.clientY, startPosX: pos.x, startPosY: pos.y };
  };
  const handlePointerMove = (e: React.PointerEvent) => {
    if (dragRef.current) {
      let newX = dragRef.current.startPosX + e.clientX - dragRef.current.startX;
      let newY = dragRef.current.startPosY + e.clientY - dragRef.current.startY;
      newX = clamp(newX, 0, window.innerWidth - 100);
      newY = clamp(newY, 0, window.innerHeight - 50);
      setPos({ x: newX, y: newY });
    }
  };
  const handlePointerUp = (e: React.PointerEvent) => {
    (e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId);
    dragRef.current = null;
  };

  const isEQ = type === 'eq';
  const color = isEQ ? '#3b82f6' : '#8b5cf6';

  return (
    <div
      style={{
        position: 'absolute',
        top: `${pos.y}px`,
        left: `${pos.x}px`,
        background: 'rgba(15, 23, 42, 0.98)',
        backdropFilter: 'blur(16px)',
        border: `1px solid ${color}`,
        borderRadius: 8,
        boxShadow: '0 25px 50px -12px rgba(0,0,0,0.7)',
        zIndex: 200, // Above mixer
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden'
      }}
    >
      <div
        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 16px', background: `linear-gradient(90deg, ${color}33 0%, transparent 100%)`, borderBottom: `1px solid ${color}66`, cursor: 'move' }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      >
        <span style={{ fontSize: '0.85rem', fontWeight: 'bold', color: '#fff', letterSpacing: '0.05em' }}>
          {title} - {isEQ ? 'Equalizer' : 'Compressor'}
        </span>
        <button
          onPointerDown={e => e.stopPropagation()}
          onClick={onClose}
          style={{ background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '2px' }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"/>
            <line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>
      
      <div>
        {isEQ ? (
          <EQSection
            eq={state.eq}
            enabled={state.eqEnabled !== false}
            onChange={eq => onChange({ ...state, eq })}
            onToggleEnabled={() => onChange({ ...state, eqEnabled: state.eqEnabled === false })}
          />
        ) : (
          <CompSection
            comp={state.comp}
            enabled={state.compEnabled !== false}
            getGR={getGRLevel}
            onChange={comp => onChange({ ...state, comp })}
            onToggleEnabled={() => onChange({ ...state, compEnabled: state.compEnabled === false })}
          />
        )}
      </div>
    </div>
  );
}

// ── Pan Knob ──────────────────────────────────────────────────────────────────

function PanKnob({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const rot = value * 135; // -1 to +1 -> -135deg to +135deg
  
  const handlePointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    if (e.ctrlKey) {
      onChange(0);
      return;
    }
    const startX = e.clientX;
    const startVal = value;
    
    const handleMove = (me: PointerEvent) => {
      const deltaX = me.clientX - startX;
      const deltaVal = deltaX * 0.01;
      onChange(Math.max(-1, Math.min(1, startVal + deltaVal)));
    };
    
    const handleUp = () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
    };
    
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
  };

  return (
    <div 
      onPointerDown={handlePointerDown}
      onDoubleClick={() => onChange(0)}
      style={{
        width: 22, height: 22, borderRadius: '50%', background: '#334155', 
        position: 'relative', cursor: 'ew-resize', border: '1.5px solid #1e293b',
        boxShadow: 'inset 0 1px 2px rgba(255,255,255,0.1), 0 2px 4px rgba(0,0,0,0.5)',
        flexShrink: 0
      }}
    >
      <div style={{
        position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
        transform: `rotate(${rot}deg)`,
      }}>
        <div style={{
          position: 'absolute', top: 2, left: '50%', width: 2.5, height: 6,
          background: '#f59e0b', borderRadius: 1, transform: 'translateX(-50%)'
        }} />
      </div>
    </div>
  );
}

// ── Channel Strip ─────────────────────────────────────────────────────────────

function ChannelStrip({
  label,
  color,
  state,
  activeEffect,
  getVULevel,
  onChange,
  onOpenEffect,
  showSolo = false,
  onSolo,
  isActive = false,
  audioOffsetSeconds,
  onAudioOffsetChange,
  isLocked = false,
}: {
  label: string;
  color: string;
  state: TrackAudioState | MasterAudioState;
  activeEffect: 'eq' | 'comp' | null;
  getVULevel: () => { l: number, r: number };
  onChange: (s: any) => void;
  onOpenEffect: (type: 'eq' | 'comp') => void;
  showSolo?: boolean;
  onSolo?: () => void;
  isActive?: boolean;
  audioOffsetSeconds?: number;
  onAudioOffsetChange?: (val: number, commit: boolean) => void;
  isLocked?: boolean;
}) {
  if (!state) return null;

  const handleAudioOffsetMouseDown = (e: React.MouseEvent) => {
    if (isLocked || !onAudioOffsetChange) return;
    e.preventDefault();
    e.stopPropagation();

    const startX = e.clientX;
    const startOffset = audioOffsetSeconds || 0;
    let currentOffset = startOffset;

    const originalCursor = document.body.style.cursor;
    document.body.style.cursor = 'ew-resize';

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const deltaX = moveEvent.clientX - startX;
      // 1px = 1ms (0.001秒) の解像度で微調整し、1ms単位に丸める
      currentOffset = Math.round((startOffset + deltaX * 0.001) * 1000) / 1000;
      onAudioOffsetChange(currentOffset, false);
    };

    const handleMouseUp = () => {
      document.body.style.cursor = originalCursor;
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      onAudioOffsetChange(currentOffset, true);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  };

  const handleAudioOffsetDoubleClick = (e: React.MouseEvent) => {
    if (isLocked || !onAudioOffsetChange) return;
    e.preventDefault();
    e.stopPropagation();
    onAudioOffsetChange(0, true);
  };

  const sectionBtn = (label: string, type: 'eq' | 'comp', accentColor: string, enabled: boolean) => {
    const active = activeEffect === type;
    // active=設定画面を開いている / enabled=エフェクトが有効(チェーンに効いている)
    const bg = active ? accentColor : (enabled ? `${accentColor}26` : 'rgba(255,255,255,0.05)');
    const fg = active ? '#fff' : (enabled ? accentColor : '#64748b');
    const bd = active ? accentColor : (enabled ? `${accentColor}80` : '#334155');
    return (
      <button
        onClick={() => onOpenEffect(type)}
        style={{
          width: '100%',
          padding: '1.5px 0',
          fontSize: '0.6rem',
          fontWeight: 'bold',
          letterSpacing: '0.05em',
          background: bg,
          color: fg,
          border: `1px solid ${bd}`,
          borderRadius: 4,
          cursor: 'pointer',
          transition: 'all 0.15s',
        }}
      >
        {label}
      </button>
    );
  };

  return (
    <div style={{
      width: 58,
      height: '100%',
      boxSizing: 'border-box',
      flexShrink: 0,
      background: isActive ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.03)',
      border: `2px solid ${isActive ? color : '#1e293b'}`,
      borderRadius: 8,
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
      boxShadow: isActive ? `0 0 10px ${color}33` : 'none',
      transition: 'all 0.2s ease',
    }}>
      {/* Track Name */}
      <div style={{
        padding: '4px 2px',
        background: `linear-gradient(180deg, ${color}33 0%, transparent 100%)`,
        borderBottom: `2px solid ${color}`,
        fontSize: '0.7rem',
        fontWeight: 'bold',
        color: '#e2e8f0',
        textAlign: 'center',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        boxSizing: 'border-box',
        letterSpacing: '-0.025em'
      }}>
        {label}
      </div>

      {/* Effects */}
      <div style={{ padding: '3px 4px', display: 'flex', flexDirection: 'column', gap: 4, borderBottom: '1px solid #1e293b' }}>
        {sectionBtn('EQ', 'eq', '#3b82f6', state.eqEnabled !== false)}
        {sectionBtn('COMP', 'comp', '#8b5cf6', state.compEnabled !== false)}
      </div>

      {/* PAN & MONO */}
      <div style={{ padding: '4px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, borderBottom: '1px solid #1e293b' }}>
        <div style={{ width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
          <PanKnob value={state.pan} onChange={v => onChange({ ...state, pan: v })} />
          <span style={{ fontSize: '0.6rem', color: '#64748b', fontWeight: 'bold' }}>
            PAN {state.pan === 0 ? 'C' : `${Math.round(Math.abs(state.pan * 100))}${state.pan > 0 ? 'R' : 'L'}`}
          </span>
        </div>
        
        <button
          onClick={() => onChange({ ...state, isMono: !state.isMono })}
          style={{
            width: '100%',
            padding: '1px 0',
            fontSize: '0.6rem',
            fontWeight: 'bold',
            background: state.isMono ? '#0891b2' : 'rgba(255,255,255,0.05)',
            color: state.isMono ? '#fff' : '#94a3b8',
            border: `1px solid ${state.isMono ? '#0891b2' : '#334155'}`,
            borderRadius: 4,
            cursor: 'pointer',
          }}
        >MONO</button>
      </div>

      {/* DELAY (Audio Offset) - 高さを固定してReference/Masterと揃える */}
      {onAudioOffsetChange !== undefined ? (
        <div style={{ height: 26, padding: '3px 4px', borderBottom: '1px solid #1e293b', display: 'flex', alignItems: 'center', justifyContent: 'center', boxSizing: 'border-box' }}>
          <div
            onMouseDown={handleAudioOffsetMouseDown}
            onDoubleClick={handleAudioOffsetDoubleClick}
            style={{
              fontSize: '0.78rem',
              color: isLocked ? '#94a3b8' : '#eab308',
              background: isLocked ? 'rgba(255,255,255,0.05)' : 'rgba(234, 179, 8, 0.1)',
              border: isLocked ? '1px solid rgba(255,255,255,0.1)' : '1px solid rgba(234, 179, 8, 0.3)',
              padding: '1px 4px',
              borderRadius: '4px',
              fontFamily: 'monospace',
              cursor: isLocked ? 'not-allowed' : 'ew-resize',
              userSelect: 'none',
              textAlign: 'center',
              width: '100%',
              boxSizing: 'border-box',
              transition: 'all 0.15s ease'
            }}
            title={isLocked ? "ロックされています (解除して調整)" : "ドラッグ: 微調整 (ダブルクリックで0秒にリセット)"}
          >
            {(audioOffsetSeconds || 0) > 0 ? '+' : ''}{((audioOffsetSeconds || 0) * 1000).toFixed(0)}ms
          </div>
        </div>
      ) : (
        /* 高さ揃え用のプレースホルダー余白 */
        <div style={{ height: 26, borderBottom: '1px solid #1e293b', boxSizing: 'border-box' }} />
      )}

      {/* dB表示 (Fader & Meterの上、ストリップ全体の幅にセンタリング) */}
      <div style={{
        padding: '2px 4px',
        fontSize: '0.62rem',
        color: '#94a3b8',
        background: 'rgba(0,0,0,0.15)',
        borderBottom: '1px solid #1e293b',
        fontFamily: 'monospace',
        textAlign: 'center',
        boxSizing: 'border-box',
        width: '100%',
        letterSpacing: '-0.02em',
        flexShrink: 0
      }}>
        {state.volume === 0 ? '-∞' : (state.volume > 1 ? '+' : '') + (20 * Math.log10(state.volume)).toFixed(1) + ' dB'}
      </div>

      {/* Fader + VU Meter (底辺と高さを完璧にアライン) */}
      <div style={{ padding: '6px 4px', display: 'flex', gap: 6, alignItems: 'stretch', justifyContent: 'center', flex: 1, minHeight: 100, boxSizing: 'border-box' }}>
        <div style={{ display: 'flex', flex: 1, height: '100%', alignItems: 'stretch' }}>
          {(() => {
            const faderVal = Math.pow(state.volume / (64 / 27), 1 / 3) || 0;
            return (
              <input
                type="range"
                orient="vertical"
                min={0} max={1} step={0.001}
                value={faderVal}
                onChange={e => onChange({ ...state, volume: Math.pow(parseFloat(e.target.value), 3) * (64 / 27) })}
                onDoubleClick={() => onChange({ ...state, volume: 1.0 })}
                onClick={e => { if (e.ctrlKey) onChange({ ...state, volume: 1.0 }); }}
                className="mixer-fader"
                style={{ 
                  writingMode: 'vertical-lr', 
                  direction: 'rtl', 
                  width: '100%',
                  height: '100%',
                  margin: 0,
                  padding: 0,
                  boxSizing: 'border-box',
                  ['--fader-color' as any]: color,
                  ['--percent' as any]: `${faderVal * 100}%`
                }}
              />
            );
          })()}
        </div>
        <div style={{ height: '100%', display: 'flex', alignItems: 'stretch' }}>
          <VUMeter getLevel={getVULevel} width={24} />
        </div>
      </div>

      {/* Mute / Solo */}
      <div style={{
        height: 22,
        padding: '2px',
        display: 'flex',
        gap: 2,
        borderTop: '1px solid #1e293b',
        background: 'rgba(0,0,0,0.2)',
        boxSizing: 'border-box',
        alignItems: 'stretch'
      }}>
        {'isMuted' in state && (
          <button
            onClick={() => onChange({ ...state, isMuted: !state.isMuted })}
            style={{
              flex: 1,
              padding: '1px 0',
              fontSize: '0.65rem',
              fontWeight: 'bold',
              background: state.isMuted ? '#ef4444' : 'rgba(255,255,255,0.05)',
              color: state.isMuted ? '#fff' : '#64748b',
              border: `1px solid ${state.isMuted ? '#ef4444' : '#334155'}`,
              borderRadius: 4,
              cursor: 'pointer',
            }}
          >M</button>
        )}
        {showSolo && onSolo && 'isSoloed' in state && (
          <button
            onClick={onSolo}
            style={{
              flex: 1,
              padding: '1px 0',
              fontSize: '0.65rem',
              fontWeight: 'bold',
              background: state.isSoloed ? '#eab308' : 'rgba(255,255,255,0.05)',
              color: state.isSoloed ? '#000' : '#64748b',
              border: `1px solid ${state.isSoloed ? '#eab308' : '#334155'}`,
              borderRadius: 4,
              cursor: 'pointer',
            }}
          >S</button>
        )}
      </div>
    </div>
  );
}

// ── MixerModal ────────────────────────────────────────────────────────────────

interface MixerModalProps {
  tracks: TrackData[];
  masterState: MasterAudioState;
  onClose: () => void;
  onUpdateAudioState: (id: string, newState: TrackAudioState) => void;
  onUpdateMasterState: (newState: MasterAudioState) => void;
  activeCameraId?: string;
  onUpdateAudioOffset?: (id: string, val: number, commit: boolean) => void;
}

type ActiveEffect = { trackId: string; type: 'eq' | 'comp' } | null;

export function MixerModal({ tracks, masterState, onUpdateAudioState, onUpdateMasterState, activeCameraId, onUpdateAudioOffset }: MixerModalProps) {
  const [activeEffect, setActiveEffect] = useState<ActiveEffect>(null);

  const handleSolo = useCallback((soloId: string) => {
    const anyOtherSoloed = tracks.some(t => t.id !== soloId && t.audioState.isSoloed);
    const thisSoloed = tracks.find(t => t.id === soloId)?.audioState.isSoloed;
    tracks.forEach(t => {
      const shouldSolo = !anyOtherSoloed && !thisSoloed ? (t.id === soloId) : (t.id === soloId ? !thisSoloed : false);
      onUpdateAudioState(t.id, { ...t.audioState, isSoloed: shouldSolo });
    });
  }, [tracks, onUpdateAudioState]);


  // Resolve active effect state
  let effectTitle = '';
  let effectState: TrackAudioState | MasterAudioState | null = null;
  let effectGRLevel = () => 0;
  let effectOnChange = (_s: any) => {};

  if (activeEffect) {
    if (activeEffect.trackId === 'MASTER') {
      effectTitle = 'MASTER';
      effectState = masterState;
      effectGRLevel = () => audioEngine.getMasterGRLevel();
      effectOnChange = onUpdateMasterState;
    } else {
      const t = tracks.find(t => t.id === activeEffect.trackId);
      if (t) {
        effectTitle = t.name;
        effectState = t.audioState;
        effectGRLevel = () => audioEngine.getTrackGRLevel(t.id);
        effectOnChange = s => onUpdateAudioState(t.id, s);
      } else {
        setActiveEffect(null);
      }
    }
  }

  return (
    <>
      <div
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          background: 'transparent',
          overflow: 'hidden',
          userSelect: 'none',
        }}
      >
        {/* Main strips layout (Master always pinned to the right) */}
        <div style={{ display: 'flex', padding: '12px', alignItems: 'stretch', flex: 1, height: '100%', boxSizing: 'border-box', overflow: 'hidden' }}>
          {/* Scrollable Tracks container */}
          <div className="mixer-tracks-scroll" style={{ display: 'flex', gap: 4, overflowX: 'auto', overflowY: 'hidden', alignItems: 'stretch', flex: 1, paddingBottom: 8 }}>
            {tracks.map((track) => (
              <ChannelStrip
                key={track.id}
                label={track.isRef ? 'Ref' : track.name}
                color={getTrackColor(track, tracks)}
                state={track.audioState}
                activeEffect={activeEffect?.trackId === track.id ? activeEffect.type : null}
                getVULevel={() => audioEngine.getTrackMeterLevel(track.id, track.audioState.isMono)}
                onChange={s => onUpdateAudioState(track.id, s)}
                onOpenEffect={type => setActiveEffect(prev => prev?.trackId === track.id && prev.type === type ? null : { trackId: track.id, type })}
                showSolo={true}
                onSolo={() => handleSolo(track.id)}
                isActive={activeCameraId === track.id}
                audioOffsetSeconds={!track.isRef ? (track.audioOffsetSeconds || 0) : undefined}
                onAudioOffsetChange={!track.isRef ? (val, commit) => onUpdateAudioOffset?.(track.id, val, commit) : undefined}
                isLocked={track.isLocked}
              />
            ))}
          </div>

          {/* Divider */}
          {tracks.length > 0 && (
            <div style={{ width: 2, background: 'rgba(255,255,255,0.1)', alignSelf: 'stretch', margin: '0 8px 8px 8px', borderRadius: 1, flexShrink: 0 }} />
          )}

          {/* Master */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'stretch', paddingBottom: 8, boxSizing: 'border-box', flexShrink: 0 }}>
            <ChannelStrip
              label="MASTER"
              color="#f43f5e"
              state={masterState}
              activeEffect={activeEffect?.trackId === 'MASTER' ? activeEffect.type : null}
              getVULevel={() => audioEngine.getMasterMeterLevel(masterState.isMono)}
              onChange={s => onUpdateMasterState(s)}
              onOpenEffect={type => setActiveEffect(prev => prev?.trackId === 'MASTER' && prev.type === type ? null : { trackId: 'MASTER', type })}
              showSolo={false}
            />
          </div>
        </div>
      </div>

      {/* Floating Effect Window */}
      {activeEffect && effectState && (
        <EffectWindow
          title={effectTitle}
          type={activeEffect.type}
          state={effectState}
          getGRLevel={effectGRLevel}
          onChange={effectOnChange}
          onClose={() => setActiveEffect(null)}
        />
      )}
    </>
  );
}
