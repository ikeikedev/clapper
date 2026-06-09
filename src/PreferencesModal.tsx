import React, { useState, useEffect } from 'react';

export interface AppPreferences {
  projectFps: 24 | 29.97 | 30 | 60;
  defaultTransitionType: 'cut' | 'crossfade';
  defaultTransitionDuration: number;
}

export const DEFAULT_PREFERENCES: AppPreferences = {
  projectFps: 60,
  defaultTransitionType: 'cut',
  defaultTransitionDuration: 0.5,
};

interface PreferencesModalProps {
  onClose: () => void;
  onSave: (prefs: AppPreferences) => void;
}

export const PreferencesModal: React.FC<PreferencesModalProps> = ({ onClose, onSave }) => {
  const [prefs, setPrefs] = useState<AppPreferences>(DEFAULT_PREFERENCES);

  useEffect(() => {
    const saved = localStorage.getItem('mcse_preferences');
    if (saved) {
      try {
        setPrefs({ ...DEFAULT_PREFERENCES, ...JSON.parse(saved) });
      } catch (e) {
        console.error("Failed to load preferences from localStorage", e);
      }
    }
  }, []);

  const handleSave = () => {
    localStorage.setItem('mcse_preferences', JSON.stringify(prefs));
    onSave(prefs);
    onClose();
  };

  const handleReset = () => {
    setPrefs(DEFAULT_PREFERENCES);
  };

  return (
    <div 
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: 'rgba(5, 8, 15, 0.85)',
        backdropFilter: 'blur(8px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 2000,
        animation: 'fadeIn 0.2s ease-out'
      }}
    >
      <div 
        style={{
          background: '#111827',
          border: '1px solid #1e293b',
          borderRadius: '12px',
          width: '520px',
          maxWidth: '90%',
          boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.5), 0 10px 10px -5px rgba(0, 0, 0, 0.4)',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column'
        }}
      >
        {/* Header */}
        <div 
          style={{
            padding: '16px 24px',
            borderBottom: '1px solid #1e293b',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center'
          }}
        >
          <h2 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 600, color: '#f8fafc', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'inline-block' }}>
              <circle cx="12" cy="12" r="3"/>
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
            </svg>
            環境設定 (Preferences)
          </h2>
          <button 
            onClick={onClose}
            style={{
              background: 'transparent',
              border: 'none',
              color: '#94a3b8',
              cursor: 'pointer',
              padding: '4px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: '4px',
              transition: 'background 0.2s'
            }}
            onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.05)'}
            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"/>
              <line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        {/* Content */}
        <div style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: '20px', maxHeight: '70vh', overflowY: 'auto' }}>

          {/* Section: Frame Rate */}
          <div>
            <h3 style={{ margin: '0 0 12px 0', fontSize: '0.9rem', color: '#60a5fa', borderBottom: '1px solid #1e293b', paddingBottom: '4px', fontWeight: 600 }}>
              フレームレート設定
            </h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <label style={{ display: 'block', fontSize: '0.8rem', color: '#cbd5e1', marginBottom: '4px' }}>
                プロジェクトフレームレート:
              </label>
              <select
                value={prefs.projectFps ?? 60}
                onChange={e => setPrefs(prev => ({ ...prev, projectFps: Number(e.target.value) as any }))}
                style={{
                  width: '100%',
                  padding: '8px',
                  background: '#1f2937',
                  border: '1px solid #374151',
                  borderRadius: '6px',
                  color: '#e2e8f0',
                  outline: 'none',
                  cursor: 'pointer'
                }}
              >
                <option value={24}>24 fps</option>
                <option value={29.97}>29.97 fps</option>
                <option value={30}>30 fps</option>
                <option value={60}>60 fps</option>
              </select>
              <span style={{ fontSize: '0.7rem', color: '#64748b' }}>
                キーボード←→ボタン・オフセットドラッグ時の1フレームの時間幅を決めます。
              </span>
            </div>
          </div>


        </div>

        {/* Footer */}
        <div 
          style={{
            padding: '16px 24px',
            borderTop: '1px solid #1e293b',
            background: '#0f172a',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center'
          }}
        >
          <button 
            onClick={handleReset}
            style={{
              padding: '6px 12px',
              background: 'transparent',
              border: '1px solid #334155',
              borderRadius: '4px',
              color: '#94a3b8',
              fontSize: '0.8rem',
              cursor: 'pointer',
              transition: 'all 0.2s'
            }}
            onMouseEnter={e => { e.currentTarget.style.color = '#fff'; e.currentTarget.style.borderColor = '#475569'; }}
            onMouseLeave={e => { e.currentTarget.style.color = '#94a3b8'; e.currentTarget.style.borderColor = '#334155'; }}
          >
            初期値に戻す
          </button>
          
          <div style={{ display: 'flex', gap: '10px' }}>
            <button 
              onClick={onClose}
              style={{
                padding: '6px 16px',
                background: 'transparent',
                border: 'none',
                color: '#94a3b8',
                fontSize: '0.8rem',
                cursor: 'pointer'
              }}
              onMouseEnter={e => e.currentTarget.style.color = '#fff'}
              onMouseLeave={e => e.currentTarget.style.color = '#94a3b8'}
            >
              キャンセル
            </button>
            <button 
              onClick={handleSave}
              style={{
                padding: '6px 20px',
                background: '#3b82f6',
                border: 'none',
                borderRadius: '4px',
                color: '#fff',
                fontWeight: 500,
                fontSize: '0.8rem',
                cursor: 'pointer',
                transition: 'background 0.2s'
              }}
              onMouseEnter={e => e.currentTarget.style.background = '#2563eb'}
              onMouseLeave={e => e.currentTarget.style.background = '#3b82f6'}
            >
              保存する
            </button>
          </div>
        </div>

      </div>
    </div>
  );
};
