このフォルダのライブラリは、オフラインで動作させるためにリポジトリへ同梱しています（CDN参照なし）。

- mediabunny.min.js  Mediabunny v1.59.0 (https://mediabunny.dev/) — MPL-2.0（mediabunny.LICENSE.txt）
                     アプリが使う機能と入力形式（MP4 / MOV）だけを esbuild で束ねたもの。
                     ライブラリ本体のコードは改変していない。グローバル変数 Mediabunny として読み込む。
                     作り直す手順: npm install && npm run build:vendor
                     （含める機能は tools/mediabunny-entry.js、ビルド設定は package.json）
