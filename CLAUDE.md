# Multicam Sync Editor — CLAUDE.md

## プロジェクト概要

複数カメラ映像を音声波形の相互相関で自動同期し、カット編集・音声ミキシング・カラーグレーディングを行ってマルチカム動画として書き出すデスクトップアプリ。

ライブ収録・スポーツ撮影など「複数台カメラを使ったが現場でクラップボードを使っていない」ケースを主なターゲットとする。

**開発状況: BETA（主要機能は実装済み、UIラベルも BETA 表示中）**

---

## 技術スタック

| レイヤー | 技術 |
|---|---|
| フロントエンド | React 18 + TypeScript + Vite |
| デスクトップシェル | Tauri v2（Windows専用、decorations: false でカスタムタイトルバー） |
| バックエンド処理 | Rust（Tauri コマンド） |
| 音声/映像処理 | FFmpeg（`ffmpeg.exe` をプロジェクトルートにバンドル） |
| 音声エンジン | Web Audio API（`AudioEngine.ts`、シングルトン） |
| オーディオ同期計算 | rustfft による FFT 相互相関（250Hz エンベロープ） |

---

## ディレクトリ構成

```
multicam-sync-editor/
├── src/                       # React フロントエンド
│   ├── App.tsx                # メインコンポーネント（約3100行、状態管理の中枢）
│   ├── Timeline.tsx           # タイムライン・波形・カットマーカー
│   ├── VideoPreview.tsx       # 動画プレビュー（プロキシ再生）
│   ├── AudioEngine.ts         # Web Audio API シングルトン
│   ├── WaveformRenderer.tsx   # Canvas 波形レンダラー
│   ├── MixerModal.tsx         # オーディオミキサー UI
│   ├── ExportModal.tsx        # エクスポート設定 UI
│   ├── PreferencesModal.tsx   # 環境設定 UI
│   └── types.ts               # 共有型定義
├── src-tauri/
│   ├── src/lib.rs             # Tauri コマンド全実装（約1080行）
│   └── tauri.conf.json        # アプリ設定（1400x900、decorations: false）
├── ffmpeg.exe                 # バンドル済み FFmpeg バイナリ
└── CLAUDE.md                  # このファイル
```

---

## 実装済み機能

### コア機能
- **マルチトラック管理** — REF（基準）トラック + 複数カメラアングル
- **自動同期** — Rust 側で FFT 相互相関によりオーディオオフセットを秒単位で算出（250Hz エンベロープ + 40Hz HP / 3kHz LP フィルタ）
- **エンベロープキャッシュ** — `OnceLock<Mutex<HashMap>>` によりセッション中の再計算を回避
- **プロキシ動画生成** — libx264 superfast で 720p/480p/360p の低解像度プロキシを非同期生成、進捗は `proxy-progress` イベントで通知
- **プロジェクト保存/読込** — JSON 形式（`tracks`, `cuts`, `exportRange`）

### タイムライン
- Canvas 波形表示（50 points/秒）
- カットポイントの追加・削除・時間ドラッグ
- ズームイン/アウト（`pixelsPerSecond`）
- 書き出し範囲（In/Out 点）の視覚的操作
- 再生ヘッドの自動スクロール（閾値/目標位置を Preferences で調整可）

### 音声処理（Web Audio API）
トラックごとのチェーン: `MediaElementSource → Compressor → 5バンドEQ → StereoPanner → Gain → MasterGain`
マスターチェーン: `MasterGain → MasterEQ → MasterComp → MonitorGain → destination`
VU メーター（L/R）、GR メーター（コンプ GainReduction）付き

### エクスポート
- エンコーダ: NVENC / QSV / AMF / libx264
- 解像度: 720p / 1080p / 4K
- フレームレート: 24 / 30 / 60 fps
- 音声品質: AAC 256k / AAC 384k / ALAC（ロスレス）
- ラウドネス正規化: `-14 LUFS`（FFmpeg loudnorm フィルタ）
- 書き出し範囲（In/Out 点）
- フェードイン/フェードアウト
- トランジション: カット / クロスフェード / ディップトゥブラック / ディップトゥホワイト
- 進捗: `export-progress` イベントで %通知

### カラーグレーディング
- 色温度 / 色合い / 露出 / コントラスト（各トラック独立）
- エクスポート時に FFmpeg `colorbalance` + `eq` フィルタとして適用

### UX
- Undo/Redo（50 ステップ）
- キーボードショートカット（Space=再生, C=カット, Ctrl+Z/Y, 1〜9=アングル切替, [/]=In/Out点）
- ドラッグ＆ドロップ（左半分=REF、右半分=カメラ追加）
- トラックロック（誤操作防止）
- 音声のみトラック（REF に MP3/WAV を設定可）
- 環境設定（プロキシ品質、FPS、スクロール挙動）を localStorage に永続化

---

## Tauri コマンド一覧（Rust ↔ フロントエンド I/F）

| コマンド | 用途 |
|---|---|
| `extract_audio` | 動画から WAV を抽出（8kHz モノラル、キャッシュあり） |
| `generate_waveform` | WAV から 50pts/秒のピーク配列を生成 |
| `generate_proxy_video` | 低解像度プロキシ動画を生成（進捗イベント付き） |
| `calculate_sync_offset` | FFT 相互相関でオフセット秒数を計算 |
| `export_video` | FFmpeg filter_complex を組み立てて書き出し |
| `save_project_file` | プロジェクト JSON をファイルに書き込み |
| `load_project_file` | プロジェクト JSON をファイルから読み込み |

---

## 開発コマンド

```bash
# フロントエンド開発サーバー（単体）
npm run dev

# Tauri 開発起動（フロントエンド + Rust 同時）
npm run tauri dev

# Tauri ビルド（インストーラ生成）
npm run tauri build
```

FFmpeg は `ffmpeg.exe` をプロジェクトルートに置くか、PATH に通しておく必要がある。
`find_ffmpeg()` が exe ディレクトリ → カレント → 親 → 2階層上 → PATH の順で探す。

---

## 重要な設計ルール

### 状態管理
- グローバル状態は `App.tsx` の `useState` で一元管理（Context / 外部ストアは使わない）
- 変更を伴う操作はすべて `pushHistory(tracks, cuts)` を呼び Undo スタックに積む
- `isPlayingRef` / `tracksRef` / `currentTimeRef` など `useRef` でアニメーションループから最新値を読む

### Audio/Video 同期
- 再生ループは `requestAnimationFrame` + REF トラックの `HTMLMediaElement.currentTime` を正とし、他トラックはオフセット計算のみ行う（映像同期は `VideoPreview` 内で処理）
- シーク中は `isSeekingRef` を立てて進行を一時停止する（400ms タイムアウト）

### FFmpeg パス
- `find_ffmpeg()` を必ず使う。直接 `"ffmpeg"` をハードコードしない

### エクスポートの filter_complex
- カット数 0 件でもクラッシュしないよう `if cuts.is_empty()` 分岐がある（Bug 3 修正済み）
- オーディオはすべて `amix` で合算してから `loudnorm` を適用する順序を守る

### CSS / スタイリング
- Tailwind は使っていない。インラインスタイルと `App.css` / `index.css` で管理
- ダークテーマ固定（`#0f172a` 系パレット）

---

## 既知の技術的負債

1. **`App.tsx` が約 3100 行** — ロジックは機能ドメインごとにカスタムフックへ分割することが望ましいが、現状はモノリシック
2. **`README.md` が Vite テンプレートのまま** — プロジェクト固有の内容に差し替えが必要
3. **`tauri.conf.json` の `identifier`** が `com.tauri.dev` のまま — リリース前に変更要
4. **`Cargo.toml` の `authors`** が `["you"]` のまま

---

## 今後の開発候補タスク（優先度順）

1. `App.tsx` のリファクタリング（カスタムフック分離: `usePlayback`, `useTracks`, `useCuts`, `useHistory`）
2. タイムライン上での「カットカードのドラッグによるアングル切替」UI 改善
3. オーディオオフセット（映像オフセットとは独立した音声ズレ補正）のより直感的な UI
4. プロジェクトファイルのバージョン管理（スキーマバージョンフィールド追加）
5. `tauri.conf.json` の identifier / 作者情報の正式設定
6. `README.md` をプロジェクト説明に差し替え
7. Windows 以外のプラットフォーム対応（現状 `decorations: false` の実装が Windows 前提）
