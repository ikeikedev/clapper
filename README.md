# Clapper — マルチカム同期エディタ

複数のカメラ映像を**音声波形の相互相関で自動同期**し、カット編集・音声ミキシング・カラーグレーディングを行ってマルチカム動画として書き出す Windows デスクトップアプリです。

ライブ収録やスポーツ撮影など「複数台のカメラで撮ったが、現場でクラップボード（カチンコ）を使っていない」ケースを主なターゲットにしています。各カメラの音声からズレを自動算出するため、手動での頭出しが不要です。

---

## 使い方（解説動画）

基本操作から3カメラのマルチカット編集まで、ひと通りの使い方を動画で解説しています。

[![Clapper 使い方解説](https://img.youtube.com/vi/wYv3KyWqJmg/maxresdefault.jpg)](https://youtu.be/wYv3KyWqJmg)

---

## ダウンロード

[**Releases ページ**](https://github.com/ikeikedev/clapper/releases) から `Clapper_x.x.x_x64-setup.exe` をダウンロードしてインストールしてください。**FFmpeg は同梱済み**のため、追加のセットアップは不要です。

> ⚠️ 署名されていないアプリのため、初回起動時に Windows SmartScreen の警告が表示される場合があります。「詳細情報」→「実行」で続行してください。

---

## 主な機能

- **自動同期** — REF（基準）トラックと各カメラの音声を FFT 相互相関で解析し、オフセットを秒単位で自動算出
- **マルチトラック編集** — REF トラック＋複数カメラアングル、トラックロック、音声のみトラック対応
- **タイムライン** — Canvas 波形表示、カットポイントの追加/削除/ドラッグ、ズーム、書き出し範囲（In/Out 点）
- **DAW式再生エンジン** — Web Audio によるサンプル精度のチャンク再生で、長時間でもドリフトしない滑らかなプレビュー
- **オーディオミキサー** — トラックごとのコンプレッサー・7バンドEQ・パン・音量、マスターチェーン、VU/GR メーター（Web Audio API）
- **カラーグレーディング** — 色温度・色合い・露出・コントラストをトラック単位で調整
- **エクスポート** — NVENC/QSV/AMF/libx264 エンコーダ、720p/1080p/4K、24/30/60fps、AAC/ALAC、ラウドネス正規化(-14 LUFS)、フェードイン/アウト、トランジション（カット/クロスフェード/黒・白ディップ）
- **UX** — Undo/Redo、キーボードショートカット、ドラッグ＆ドロップ、未保存変更の警告、環境設定の永続化

---

## 技術スタック

| レイヤー | 技術 |
|---|---|
| フロントエンド | React 19 + TypeScript + Vite |
| デスクトップシェル | Tauri v2（Windows、カスタムタイトルバー） |
| バックエンド処理 | Rust（Tauri コマンド） |
| 音声/映像処理 | FFmpeg（`ffmpeg.exe`） |
| 音声エンジン | Web Audio API |
| 同期計算 | rustfft による FFT 相互相関（250Hz エンベロープ） |

---

## 必要要件（ソースから実行する場合）

※ Releases のインストーラを使う場合は FFmpeg 同梱済みのため、このセクションは不要です（開発者向け）。

- Windows 10/11
- **FFmpeg** — `ffmpeg.exe` をプロジェクトルートに配置する（または PATH を通す）。
  リポジトリには同梱していないため、[FFmpeg 公式](https://ffmpeg.org/download.html) 等から取得して配置してください。
  `find_ffmpeg()` が「実行ファイルの隣 → リソース → カレント → 親 → PATH」の順で探索します。

---

## 開発

```bash
# 依存関係のインストール
npm install

# フロントエンド開発サーバー（単体）
npm run dev

# Tauri 開発起動（フロントエンド + Rust 同時）
npm run tauri dev

# 本番ビルド（インストーラ生成）
npm run tauri build
```

ビルド時は `tauri.conf.json` の `bundle.resources` 設定により `ffmpeg.exe` がインストーラに同梱されます。

---

## ライセンス

Clapper 本体は [MIT License](LICENSE) © 2026 ike で提供されます。

### 同梱ソフトウェア（FFmpeg）について

本アプリは動画・音声処理に **FFmpeg**（`ffmpeg.exe`）を同梱しています。同梱している FFmpeg は
**GPLv3** ライセンス（`--enable-gpl` ビルド、libx264/libx265 等を含む）で配布されており、
Clapper からは独立した別プロセスとして呼び出されます。

- FFmpeg のライセンス全文: [`LICENSE-FFmpeg-GPLv3.txt`](LICENSE-FFmpeg-GPLv3.txt)
- 同梱ビルドの詳細・対応するソースコードの入手方法（GPLv3 第6条の書面オファー）:
  [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)

FFmpeg のソースコードは https://github.com/FFmpeg/FFmpeg から入手できます。
