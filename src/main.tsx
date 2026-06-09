// Prevent crash on import for standard browser environment
const isTauri = typeof window !== 'undefined' && (
  (window as any).__tauri_ipc__ || 
  (window as any).__TAURI_INTERNALS__ || 
  (window as any).__tauri_internals__
);

if (typeof window !== 'undefined' && !isTauri) {
  const internals = {
    transformCallback: (callback: any) => callback,
    ipc: () => Promise.resolve(),
    metadata: {},
    convertFileSrc: (src: string) => src
  };
  try {
    if (!(window as any).__tauri_internals__) {
      (window as any).__tauri_internals__ = internals;
    }
  } catch (e) {
    console.warn("Could not mock __tauri_internals__", e);
  }
  try {
    if (!(window as any).__TAURI_INTERNALS__) {
      (window as any).__TAURI_INTERNALS__ = internals;
    }
  } catch (e) {
    console.warn("Could not mock __TAURI_INTERNALS__", e);
  }
}

import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

// Setup mock for running inside standard browser (like Puppeteer test environment)
if (typeof window !== 'undefined' && !isTauri) {
  import('@tauri-apps/api/mocks').then(({ mockIPC, mockWindows }) => {
    mockIPC((cmd, args: any) => {
      console.log(`[Tauri Mock IPC] Command: ${cmd}`, args);
      if (cmd === 'extract_audio') {
        return args.videoPath.replace(/\.[^.]+$/, '') + '.wav';
      }
      if (cmd === 'generate_waveform') {
        return Array.from({ length: 500 }, () => 0.1 + Math.random() * 0.4);
      }
      if (cmd === 'calculate_sync_offset') {
        return 0.123;
      }
      if (cmd === 'generate_proxy_video') {
        return args.videoPath.replace(/\.[^.]+$/, '') + '_proxy.mp4';
      }
      if (cmd === 'save_project_file' || cmd === 'load_project_file') {
        return '{}';
      }
      return null;
    });
    mockWindows('main');
    if ((window as any).__TAURI_INTERNALS__) {
      (window as any).__TAURI_INTERNALS__.convertFileSrc = (src: string) => src;
    }
    console.log("Tauri API mocks successfully initialized for browser.");
  }).catch(err => {
    console.error("Failed to load Tauri mocks in browser:", err);
  });
}

// WebView2 (Windows) 等のネイティブ右クリックメニューを無効化する。
// アプリ独自のコンテキストメニューはこのデフォルト動作を阻害しないよう、
// 各要素側で stopPropagation はせず、preventDefault のみで制御する。
window.addEventListener('contextmenu', (e) => {
  e.preventDefault();
});

window.addEventListener('error', (e) => {
  console.error("GLOBAL ERROR:", e.error);
  const div = document.createElement('div');
  div.style.position = 'fixed';
  div.style.top = '0';
  div.style.left = '0';
  div.style.zIndex = '9999';
  div.style.background = 'red';
  div.style.color = 'white';
  div.style.padding = '20px';
  div.style.fontSize = '20px';
  div.innerHTML = `<h1>Crash!</h1><pre>${e.error?.stack || e.message}</pre>`;
  document.body.appendChild(div);
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
