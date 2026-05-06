# 手法まとめ

## 目的

このリポジトリで現在使っている計算手法と検証手法を、現行実装に即して一箇所にまとめる。

対象は次です。

- `WebGL Bounded`
- `WebGPU Bounded`
- `WebGPU + CPU Refine`
- browser export / 数値比較
- GitHub Pages 公開経路

## 全体像

現状の役割分担は次です。

- `/` = WebGPU 主 UI
- `/webgl.html` = WebGL 検証用ルート
- 基準画像 = `img.ppm`
- 比較 = browser で `PPM` を書き出して数値比較

つまり、日常的に触る UI は WebGPU 側で、WebGL は compare の基準線として残している。

## 1. WebGL Bounded

対象:

- `webgl.html`
- `src/main.js`
- `src/renderers/webgl.js`
- `src/shaders/frag.glsl`

やっていること:

1. 複素平面上の `x` を求める
2. 固定パラメータ `y` から `z` を求める
3. sink 探索を行う
4. bounded DFS で `BQ` 判定を行う
5. その場で色を決めて描画する

性質:

- fragment shader 1 パス
- ピクセルごとの中間状態は保持しない
- compare 用の基準実装

検証コマンド:

- `pnpm compare:ref`
- `pnpm compare:ref:640`

## 2. WebGPU Bounded

対象:

- `index.html`
- `src/webgpu-main.js`
- `src/renderers/webgpu.js`
- `src/shaders/webgpu.wgsl`

やっていること:

1. compute shader で各ピクセルの `x`, `y`, `z` を計算する
2. sink 探索を行う
3. bounded DFS で `BQ` 判定を行う
4. 最終色を output texture に書く
5. blit pass で canvas に表示する

性質:

- compute + blit の 2 段構成
- output texture を持つ
- 一部の状態バッファを持てる
- 表示モードと計算方式を分離済み

UI 上の計算方式名:

- `WebGPU Bounded`

UI 上の既定値:

- `Display`: `BQ Binary Classification`
- `Calculation`: `WebGPU + CPU Refine`

補足:

- `WebGPU Bounded` は WebGPU 単独での基礎実装
- compare 精度はある程度出るが、最良ではない

## 3. WebGPU + CPU Refine

対象:

- `index.html`
- `src/webgpu-main.js`
- `src/workers/bq-refine-worker.js`
- `src/bq-cpu.mjs`

やっていること:

1. まず WebGPU Bounded で全画素を分類する
2. WebGPU 側で unresolved 画素を収集する
3. browser worker 上で CPU 実装により unresolved を再判定する
4. 最終的な compare 結果に CPU 判定を反映する

性質:

- GPU と CPU の複合経路
- 表示モードではなく計算方式
- `Show CPU Refine Preview` でブラウザ上の preview を切り替える
- 現時点で最も良い compare 結果を出している

UI 上の計算方式名:

- `WebGPU + CPU Refine`

現時点の位置づけ:

- 主 UI での既定計算方式
- 実用上の最良経路

## 4. 表示モード

表示モードは「何を描くか」だけを指す。

現行の表示モード:

- `Complex Plane Coordinates`
- `Markoff z Components`
- `Markoff |z|`
- `Quadratic Discriminant`
- `H(x) Branch Test`
- `BQ Binary Classification`

重要:

- `WebGPU + CPU Refine` は表示モードではない
- これは計算方式である

## 5. browser export と数値比較

対象:

- `scripts/render-with-browser.mjs`
- `scripts/compare-with-browser.mjs`
- `scripts/compare-images.mjs`

流れ:

1. Playwright で browser を起動する
2. 対象ページを開く
3. `window.__maskitTest.setParams()` で条件を入れる
4. `renderOnce()` を呼ぶ
5. `exportPpm()` を呼ぶ
6. `img.ppm` と数値比較する

比較は screenshot ではなく `PPM` の画素比較で行う。

主な指標:

- `mismatches`
- `falsePositive`
- `falseNegative`
- `IoU`
- `Dice`

主なコマンド:

- `pnpm compare:ref`
- `pnpm compare:webgpu:ref`

## 6. 実装上の主要 API

browser automation 用の契約は `window.__maskitTest` に集約している。

主なメソッド:

- `setParams(params)`
- `renderOnce()`
- `exportPpm()`
- `getState()`
- `resetView()`

この API を基準に、WebGL / WebGPU の両方を browser automation から扱う。

## 7. GitHub Pages

公開経路:

- `https://soma-arc.net/maskit/` = WebGPU 主 UI
- `https://soma-arc.net/maskit/webgl.html` = WebGL 検証用

自動デプロイ:

- `.github/workflows/deploy-pages.yml`
- trigger branch は `main`
- Pages 用 build は `pnpm build:pages`
- Vite の `base` は `'/maskit/'`

## 8. 現時点の整理

現在の立ち位置は次です。

- WebGL は compare 基準線
- WebGPU Bounded は GPU 単独実装
- WebGPU + CPU Refine は最良精度の実用経路
- 比較は browser export + `PPM` 数値比較
- GitHub Pages では WebGPU を主 UI として公開する

現行の実装全体を見ると、この文書を入口にして、詳細は `README.md` と `IMPLEMENTATION_NOTES.md` を参照する形が最も分かりやすい。
