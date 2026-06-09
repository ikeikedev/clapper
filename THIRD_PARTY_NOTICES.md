# サードパーティ ソフトウェアに関する通知 (Third-Party Notices)

本アプリケーション **Clapper** は MIT ライセンスで提供されますが、動画・音声処理のために
**FFmpeg** の実行ファイル（`ffmpeg.exe`）を同梱して配布しています。FFmpeg は Clapper 本体とは
独立した別個のプログラムであり、Clapper からは外部プロセスとして呼び出されます。

---

## FFmpeg

- **ライセンス:** GNU General Public License, version 3 (GPLv3)
- **同梱ビルド:** `ffmpeg version N-124714-g49a77d37be-20260531`
  （`--enable-gpl --enable-version3` 構成。libx264 / libx265 等の GPL コンポーネントを含む）
- **著作権:** Copyright (c) 2000-2026 the FFmpeg developers
- **公式サイト:** https://ffmpeg.org/
- **ライセンス全文:** 本配布物に同梱の [`LICENSE-FFmpeg-GPLv3.txt`](LICENSE-FFmpeg-GPLv3.txt)
  （原文: https://www.gnu.org/licenses/gpl-3.0.txt ）

### 対応するソースコードの入手方法（GPLv3 第6条に基づく書面によるオファー）

同梱している FFmpeg バイナリに対応する完全なソースコードは、以下から入手できます。

- FFmpeg 本体のソース（上記コミット `g49a77d37be` に対応）:
  https://github.com/FFmpeg/FFmpeg
- 当該バイナリのビルドに用いられたスクリプト・構成:
  https://github.com/BtbN/FFmpeg-Builds

上記の入手が困難な場合、本アプリの配布元（下記連絡先）に請求いただければ、頒布実費にて
対応するソースコードを提供します。

- 連絡先: ike <dx009386ikeda@gmail.com>

> 注: GPLv3 は「FFmpeg バイナリを*配布する側*」にソースコードの提供義務を課します。
> Clapper 本体（MIT）のソースとは別に、上記 FFmpeg のソース入手手段を明示することで
> これを満たしています。Clapper は FFmpeg を別プロセスとして呼び出すのみであり、
> FFmpeg のコードを静的・動的にリンクしていません。
