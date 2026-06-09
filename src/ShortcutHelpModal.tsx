import React, { useEffect } from 'react';

interface ShortcutHelpModalProps {
  onClose: () => void;
}

interface Shortcut {
  keys: string[];
  desc: string;
}

interface Section {
  title: string;
  items: Shortcut[];
}

// 実際に App.tsx の keydown ハンドラで有効になっているショートカットのみを列挙する
const SECTIONS: Section[] = [
  {
    title: 'ファイル',
    items: [
      { keys: ['Ctrl', 'N'], desc: '新規プロジェクト' },
      { keys: ['Ctrl', 'O'], desc: 'プロジェクトを開く' },
      { keys: ['Ctrl', 'S'], desc: 'プロジェクトを保存' },
      { keys: ['Ctrl', 'Shift', 'S'], desc: '名前を付けて保存' },
      { keys: ['Ctrl', 'E'], desc: '動画を書き出し' },
    ],
  },
  {
    title: '再生・移動',
    items: [
      { keys: ['Space'], desc: '再生 / 一時停止' },
      { keys: ['←', '→'], desc: '1フレーム移動（長押しで加速）' },
      { keys: ['Shift', '←', '→'], desc: '5秒移動' },
      { keys: ['↑', '↓'], desc: '前 / 次のカットへ移動' },
    ],
  },
  {
    title: '編集',
    items: [
      { keys: ['C'], desc: '現在位置にカットを追加' },
      { keys: ['1', '〜', '9'], desc: 'アングルを切り替え（プレビュー）' },
      { keys: ['Alt', '1〜9'], desc: 'その位置に指定アングルのカットを追加' },
      { keys: ['Ctrl', 'Z'], desc: '元に戻す' },
      { keys: ['Ctrl', 'Shift', 'Z'], desc: 'やり直し' },
      { keys: ['Ctrl', 'Y'], desc: 'やり直し' },
    ],
  },
  {
    title: '書き出し範囲',
    items: [
      { keys: ['['], desc: '書き出し始点を設定' },
      { keys: [']'], desc: '書き出し終点を設定' },
    ],
  },
  {
    title: 'その他',
    items: [
      { keys: ['?'], desc: 'このショートカット一覧を表示 / 閉じる' },
    ],
  },
];

const KeyCap: React.FC<{ label: string }> = ({ label }) => (
  <kbd
    style={{
      display: 'inline-block',
      minWidth: '20px',
      textAlign: 'center',
      padding: '2px 7px',
      fontSize: '0.72rem',
      fontWeight: 700,
      fontFamily: 'monospace',
      color: '#e2e8f0',
      background: '#0f172a',
      border: '1px solid #475569',
      borderBottomWidth: '2px',
      borderRadius: '4px',
      boxShadow: '0 1px 0 rgba(0,0,0,0.4)',
    }}
  >
    {label}
  </kbd>
);

export function ShortcutHelpModal({ onClose }: ShortcutHelpModalProps) {
  // Escape で閉じる
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
        background: 'rgba(0,0,0,0.7)', zIndex: 300,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#0f172a', borderRadius: '12px',
          border: '1px solid #334155', width: '440px',
          maxHeight: '85vh', display: 'flex', flexDirection: 'column', overflow: 'hidden',
        }}
      >
        {/* ヘッダー */}
        <div style={{ padding: '16px 20px', borderBottom: '1px solid #1e293b', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0, color: '#e2e8f0', fontSize: '1rem', fontWeight: 600 }}>キーボードショートカット</h2>
          <button
            onClick={onClose}
            style={{ background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer', fontSize: '1.1rem', lineHeight: 1, padding: '2px 6px' }}
            title="閉じる"
          >
            ✕
          </button>
        </div>

        <div style={{ overflowY: 'auto', padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: '18px' }}>
          {SECTIONS.map(section => (
            <div key={section.title}>
              <div style={{ fontSize: '0.72rem', fontWeight: 700, color: '#3b82f6', letterSpacing: '0.05em', marginBottom: '8px', textTransform: 'uppercase' }}>
                {section.title}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '7px' }}>
                {section.items.map((sc, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
                    <span style={{ fontSize: '0.82rem', color: '#cbd5e1' }}>{sc.desc}</span>
                    <span style={{ display: 'flex', alignItems: 'center', gap: '4px', flexShrink: 0 }}>
                      {sc.keys.map((k, j) => (
                        k === '〜' || k === '+'
                          ? <span key={j} style={{ color: '#64748b', fontSize: '0.75rem' }}>{k}</span>
                          : <KeyCap key={j} label={k} />
                      ))}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div style={{ padding: '12px 20px', borderTop: '1px solid #1e293b', textAlign: 'right' }}>
          <button onClick={onClose} className="btn-secondary">閉じる</button>
        </div>
      </div>
    </div>
  );
}
