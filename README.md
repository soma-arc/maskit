# maskit

Maskit 領域の可視化と比較を行うための実験用リポジトリです。  
現在は `pnpm + Vite` の静的サイトとして、`WebGPU` を主 UI、`WebGL2` を検証用経路として持っています。

## 現在の実装方針

### WebGL2

WebGL2 版は fragment shader ベースです。各ピクセルごとに次を 1 パスで行います。

- 複素平面上の `x` を計算
- 固定パラメータ `y` を使って `z` を計算
- sink 探索を実行
- bounded DFS による `BQ` 判定を実行
- その場で色を決めて描画

特徴は次です。

- 1 フレームごとに完結する
- ピクセルごとの中間状態は保持しない
- compare 用の基準実装として扱っている

### WebGPU

WebGPU 版は compute + blit ベースです。各ピクセルごとに次を行います。

- compute shader で `x`, `y`, `z` を計算
- sink 探索を実行
- bounded DFS による `BQ` 判定を実行
- 結果色を output texture に書く
- blit pass で output texture を canvas に表示する

特徴は次です。

- 描画は compute pass と表示 pass に分かれる
- 出力 texture と一部の状態バッファを持てる
- `WebGPU Bounded` と `WebGPU + CPU Refine` の 2 つの計算方式を持つ
- `WebGPU + CPU Refine` は `BQ Binary Classification` 表示に対してだけ意味を持つ
- `WebGPU + CPU Refine` は現時点で最も良い compare 結果を出している

つまり現時点では、WebGL2 が検証用の基準線で、WebGPU が主 UI かつ再設計先です。

## 前提

- Node.js
- pnpm
- Google Chrome または Chromium 系ブラウザ

`Playwright` 経由の browser export では Chrome を使います。必要なら `BROWSER` 環境変数で実行ファイルを指定できます。

## セットアップ

```bash
pnpm install
```

## ローカル起動

```bash
pnpm dev
```

- `http://localhost:5173/` : WebGPU 主 UI
- `http://localhost:5173/webgl.html` : WebGL2 検証用ルート

WebGL2 版では `Mode`, `y`, 描画サイズ, `sink/dfs` パラメータを調整できます。  
WebGPU 版ではそれに加えて、次を分けて扱います。

- `Display`: 何を描くか
- `Calculation`: どう計算するか
- `Show CPU Refine Preview`: CPU refine の上書き preview をブラウザ上で見せるか

現在の mode 名は次です。

- `Complex Plane Coordinates`
- `Markoff z Components`
- `Markoff |z|`
- `Quadratic Discriminant`
- `H(x) Branch Test`
- `BQ Binary Classification`

WebGPU の `Calculation` は現時点で次です。

- `WebGPU Bounded`
- `WebGPU + CPU Refine`

## 比較コマンド

基準画像は `img.ppm` です。比較結果は `out/compare/...` に出力されます。  
WebGL2 の比較系コマンドは内部的に `/webgl.html` を使います。

WebGL2 基準比較:

```bash
pnpm compare:ref
```

WebGPU 基準比較:

```bash
pnpm compare:webgpu:ref
```

高解像度の WebGL2 比較:

```bash
pnpm compare:ref:640
```

各比較コマンドは次を生成します。

- `summary.json`
- `diff.ppm`
- browser export された `ppm`

## 単体レンダリング

WebGL2 の browser export:

```bash
pnpm render:ref
```

WebGPU の browser export:

```bash
pnpm render:webgpu:ref
```

比較モード以外の描画確認には次も使えます。

```bash
pnpm render:browser
pnpm render:webgpu:browser
```

## Playwright / Browser 起動設定

Playwright の起動条件は次の 2 箇所で管理しています。

- `playwright.config.ts`
- `scripts/playwright-launch-options.mjs`

WebGPU 用では既定で次の browser args を使います。

- `--enable-unsafe-webgpu`
- `--ignore-gpu-blocklist`
- `--enable-features=Vulkan`
- `--use-angle=vulkan`
- `--disable-vulkan-surface`

必要なら次の環境変数で上書きできます。

- `BROWSER`
- `MASKIT_BROWSER_CHANNEL`
- `MASKIT_BROWSER_HEADLESS`
- `MASKIT_BROWSER_ARGS`

## 主なファイル

- `index.html`: WebGPU viewer の主エントリ
- `webgl.html`: WebGL2 viewer の検証用エントリ
- `src/main.js`: WebGL2 viewer の起動処理
- `src/webgpu-main.js`: WebGPU viewer の起動処理
- `src/renderers/webgl.js`: WebGL2 renderer
- `src/renderers/webgpu.js`: WebGPU renderer
- `src/shaders/frag.glsl`: WebGL2 shader
- `src/shaders/webgpu.wgsl`: WebGPU shader
- `scripts/render-with-browser.mjs`: Playwright 経由の browser export
- `scripts/compare-with-browser.mjs`: browser export と `img.ppm` の比較
- `scripts/compare-images.mjs`: Netpbm 同士の数値比較

## 現状の注意点

- `WebGL2` の compare mode は、現在の実用基準になっています。
- `WebGPU` も `BQ Binary Classification` を持ちますが、現時点では bounded DFS ベースの初期実装です。
- `WebGPU + CPU Refine` は表示モードではなく、計算方式です。
- 比較の合否はスクリーンショットではなく、`PPM` を読み出して数値比較します。
- `WebGPU` の browser 実行可否は Chrome 側の実行条件に依存します。起動条件は `playwright.config.ts` と `scripts/playwright-launch-options.mjs` を基準に調整してください。
