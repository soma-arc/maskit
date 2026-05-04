# 実装メモ

## 概要

このリポジトリには、同じ Vite ベースの静的サイト構成の上に 2 系統のビューアがあります。

- `index.html` + `src/webgpu-main.js`: WebGPU ビューア
- `webgl.html` + `src/main.js`: WebGL2 ビューア

目的は単なるインタラクティブ表示ではありません。どちらのビューアも browser automation から駆動でき、`PPM` として書き出した後に `img.ppm` と数値比較できます。

## プロジェクト構成

### エントリポイント

- `index.html`
  - WebGPU ビューアのページ
- `webgl.html`
  - WebGL2 ビューアのページ

### 共通モジュール

- `src/viewer-state.js`
  - 既定値と URL パラメータから初期状態を作る
- `src/ui.js`
  - DOM 取得
  - 入力同期
  - canvas の表示サイズ制御
  - ステータス文字列の整形
- `src/ppm-export.js`
  - RGBA ピクセルバッファから `P3` PPM テキストを生成する
  - ブラウザ側のファイルダウンロードを扱う

### レンダラ

- `src/renderers/webgl.js`
  - WebGL2 パイプライン初期化
  - draw call 発行
  - `readPixels()` 対応
- `src/renderers/webgpu.js`
  - WebGPU device/context 初期化
  - compute pass
  - 出力 texture の blit pass
  - 出力 texture の readback
  - ピクセルごとの状態バッファの readback

### シェーダ

- `src/shaders/frag.glsl`
  - WebGL fragment shader
- `src/shaders/webgpu.wgsl`
  - WebGPU compute + blit shader

### 自動化・比較スクリプト

- `scripts/render-with-browser.mjs`
  - Playwright 経由で Chrome を起動する
  - ビューアページを開く
  - `window.__maskitTest` を呼ぶ
  - 書き出した `PPM` を保存する
- `scripts/compare-with-browser.mjs`
  - browser render と数値比較を 1 コマンドで行う
  - 実行履歴 manifest を `out/history/` に書き出す
- `scripts/compare-images.mjs`
  - 基準画像とレンダリング画像を比較する
  - 指標と差分画像を出力する
- `scripts/playwright-launch-options.mjs`
  - browser 起動オプションの共通定義
- `playwright.config.ts`
  - Playwright 側の起動設定の集約

## ビューア状態

現在のビューア状態は class ではなく plain object です。主な項目は次です。

- 出力サイズ: `width`, `height`
- 複素平面の表示範囲: `offsetX`, `offsetY`, `scale`
- BQ パラメータ: `yReal`, `yImag`
- 表示モード: `mode`
- 計算方式: `solver`（WebGPU のみ）
- 有界探索の上限:
  - `maxSinkIters`
  - `maxDfsDepth`
  - `maxDfsVisits`

WebGL / WebGPU の両ビューアで同じ形を使うことで、自動化層から同じ API で操作できるようにしています。

## ブラウザ自動化の契約

両ビューアとも `window.__maskitTest` を公開します。

現在のメソッドは次です。

- `setParams(params)`
  - 描画サイズ、複素平面の表示範囲、`y`、表示モード、有界探索上限を更新する
- `renderOnce()`
  - ちょうど 1 フレーム描画し、計測値と状態を返す
- `exportPpm()`
  - 現在フレームを `P3` PPM テキストとして返す
- `getState()`
  - 現在の state と計測値を返す
- `resetView()`
  - `BQ.py` 互換の既定表示範囲へ戻す

WebGPU では加えて次も公開します。

- `getPixelState(x, y)`
  - WebGPU の storage buffer から 1 ピクセル分の中間状態を読む

この API は意図的に小さく保っています。Playwright スクリプトが依存する安定した契約です。

## WebGL 実装

WebGL 経路は、いまも fragment shader 主導です。

主な特徴は次です。

- render pass は 1 回
- bounded sink + bounded DFS のロジックを shader 内に持つ
- compare mode は二値
- フレーム後にピクセルごとの中間状態は保持しない

この経路はすでに基準比較に十分使えており、ブラウザ実装内の基準線になっています。

## WebGPU 実装

WebGPU 経路は、単純な fragment 風移植を超えた段階に進んでいます。

### 現在のパイプライン

1. CPU が uniform を書き込む
2. compute pass が各ピクセルのサンプルを評価する
3. compute pass が次を書き込む
   - 表示用の最終色を output texture に書く
   - 中間状態を storage buffer に書く
4. blit render pass が output texture をサンプリングして canvas に表示する

つまり、数理ロジック自体はまだ WebGL の bounded 実装に近いものの、WebGPU 側には明示的な compute stage がすでにあります。

### 出力 texture

compute pass は最終色を storage texture に書きます。この texture は次に使います。

- blit pass によるブラウザ表示
- copy-to-buffer による export / readback

表示と export が同じレンダリング結果を共有しています。

### ピクセルごとの状態バッファ

WebGPU では 1 ピクセルごとに `PixelState` を保持します。

現在の内容は次です。

- `x.real`
- `x.imag`
- `y.real`
- `y.imag`
- `z.real`
- `z.imag`
- `statusCode`
- 予約スロット

これは主にデバッグと、将来の multi-pass 化のためです。

### 内部ステータス値

WebGPU では内部状態を subtype 付きで保持します。

- `0`: false
- `1`: true
- `2`: unknown_sink
- `3`: unknown_dfs_limit
- `4`: unknown_stack

これにより、未解決画素をひとまとめに扱うのではなく、失敗モードごとに分けて扱えます。

現在の compare 挙動は次です。

- mode `5` は数値比較用の二値表示
- `true` だけを黒で描く
- compare 表示では unresolved を `true` 以外として扱う

## 表示モード

共通モード:

- `0`: Coordinates
- `1`: z components
- `2`: `|z|`
- `3`: Discriminant
- `4`: `H(x)` branch
- `5`: BQ Binary Classification

現在 UI に出している表示モードはこの 6 個だけです。

WebGPU 側では表示モードとは別に `Calculation` selector を持ちます。

- `WebGPU Bounded`
- `WebGPU + CPU Refine`

`WebGPU + CPU Refine` は表示モードではなく、`BQ Binary Classification` をどう計算するかの選択です。

## 比較フロー

数値比較の経路は次です。

1. browser を起動する
2. ビューアページを開く
3. `window.__maskitTest.setParams(...)` を呼ぶ
4. `window.__maskitTest.renderOnce()` を呼ぶ
5. `window.__maskitTest.exportPpm()` を呼ぶ
6. レンダリング画像を保存する
7. `img.ppm` と比較する

比較スクリプトは次を報告します。

- 総ピクセル数
- 一致数 / 不一致数
- false positive / false negative
- IoU / Dice
- 利用可能なら WebGPU の classification stats
- 利用可能なら unknown 画素サンプル
- 差分画像のパス

これは主要な検証経路です。Screenshot VRT は主目的ではありません。

### 実行履歴

`scripts/compare-with-browser.mjs` を実行すると、毎回 `out/history/` に manifest を書きます。

生成されるファイル:

- `out/history/<timestamp>-<compare-label>.json`
  - 実行 1 回分の完全な manifest
- `out/history/latest-<compare-label>.json`
  - その compare ターゲットの最新結果
- `out/history/index.jsonl`
  - 追記専用の要約インデックス

manifest に含める内容:

- timestamp
- git SHA
- compare パラメータ
- render state
- comparison summary
- classification stats
- unknown sample
- artifact のパス

後続のエージェントが「何を検証し、どこまで tuning が進んだか」を復元するときの主な根拠はこれです。

## Python 参照実装の挙動

`BQ.py` は、いまも `img.ppm` を生成する参照実装です。

これは重要です。GPU 側はいま、別の厳密 oracle ではなく Python の出力に合わせて評価されています。

### Python の分類フロー

各ピクセルに対して `BQ.py` は次を行います。

1. ピクセルを複素数 `x` に写す
2. 固定の `y` を使う
3. Markoff 型関係式から `z` を計算する
4. `BQ(a, b, c)` を呼ぶ

`BQ(a, b, c)` の中では次を行います。

- `|a| < 0.5` または `|b| < 0.5` または `|c| < 0.5` なら `False`
- `a, b, c` のうち、より小さい隣接値へ置換しながら sink に向かって進む
- sink 近傍が `0.5` 未満なら `False`
- sink に着いたら 3 本の DFS を起動する

`BQ_dfs(a, b, c, depth)` の中では次を行います。

- `depth > 995` なら打ち切って `True`
- `BQ1` の実区間 failure が見つかったら `False`
- 現在の edge が `T(1)` の外ならその枝を打ち切って `True`
- `|d| < 0.5` なら `False`
- それ以外は 2 つの子枝へ再帰する

### 重要な帰結

Python は明示的な `unknown` 状態を外へ出しません。

代わりに、探索が深すぎるときはその不確実性を `True` として潰します。

つまり参照挙動は実質的に次です。

- `false`
- `true`
- そして「give up」を `true` に畳み込んだもの

このため WebGPU 側では次を分けて扱います。

- デバッグと refinement のために内部で持つ tri-state / subtype 状態
- 参照比較のために使う最終二値出力

意図している長期的な WebGPU 挙動は次です。

- refinement 可能な間は内部で `unknown` を保持する
- デバッグモードでは unresolved `unknown` をそのまま見せる
- ただし参照互換の最終二値出力では、Python の `give up -> True` に合わせて unresolved `unknown` を `true` に潰せるようにする

## 現在わかっている挙動

### WebGL

- 安定しており、ブラウザアプリ内の主な基準実装として使っている
- compare 結果も `img.ppm` にかなり近い

### WebGPU

- compute -> blit でブラウザ表示できる
- headless compare も概ね動く
- headless WebGPU adapter 取得は環境依存のまま
- 内部 tri-state / subtype 状態が利用可能
- 主 UI は `index.html` に集約済み
- `Display` と `Calculation` は分離済み

## なぜここで WebGPU が重要か

現在の WebGL 実装は、fragment shader だけで bounded DFS を回す構成としては実用上の限界に近いです。

WebGPU に移る意義は次です。

- 明示的な compute pass
- ピクセルごとの永続状態
- 将来の multi-pass refinement
- 中間値の検査のしやすさ
- 次の段階的な分離
  - 初期サンプル計算
  - sink stage
  - DFS stage
  - refinement / unknown handling

現在の実装は、その構造へ向かう最初の段階であり、最終形ではありません。

## 現在の制約

- BQ ロジックはまだ bounded 近似
- compare mode は内部が tri-state でも出力はまだ二値
- unresolved subtype は内部状態として保持しているが、現在の UI では表示モードとしては出していない
- ピクセル状態は個別 inspection 用に 1 ピクセルずつ readback しており、まだ bulk 解析していない
- multi-pass refinement は未実装

## 最もありそうな次の一手

次にやるべきことは、大きな全面書き換えではありません。新しく持てるようになった WebGPU state buffer を使って、不確実性を計測・要約することです。

具体的には次が考えられます。

- `unknown` 画素数を数える
- automation から集計値を出せるようにする
- `unknown` 領域と数値 mismatch の相関を見る

これが見えると、次の構造変更も判断しやすくなります。

- bounded 上限を詰めるのか
- sink / DFS / refinement を別 compute pass に分けるのか

## 次候補のアイデア

現在の WebGPU 実装では `unknown_stack` はすでに解消しており、bounded DFS のさらなる tuning は逓減に入っています。

この段階で有望なのは、「とにかく上限をさらに増やす」ことではなく、次のような対象限定の方策です。

### 1. GPU 粗判定 + unresolved 画素の CPU 確定

WebGPU を全画面分類器として使い、unresolved だけを CPU/CLI 側で再判定します。

魅力:

- `unknown` 画素をすでに観測できる
- 追加計算が必要なのはフレームのごく一部
- 難しい末尾だけを救うために全画面を重くしなくてよい

想定構成:

- WebGPU が二値フレームと unresolved index list を出す
- Node.js が unresolved の座標を読む
- CPU 側ロジックがその画素だけを、より bounded でない形で再評価する
- 比較前に最終出力へ反映する

これは `WebGPU + CPU Refine` として、すでに現在の最良 compare 経路になっている。

### 2. unresolved tile だけ再描画する

個別画素を CPU で再評価する代わりに、unresolved 領域だけを GPU で重い設定でもう一度回す案である。

位置づけ:

- 実験済み
- 文書上には残す
- ただし現時点では UI や主経路には採用しない

利点:

- GPU 側に完結した構成を維持できる
- 全画面へ重いコストを払わずに済む
- tile / multi-resolution refinement へ進む足場になる

想定構成:

- unresolved を bounding box または tile にまとめる
- その tile にだけ重い refinement pass を dispatch する
- 主画像へマージする

### 3. subtype を意識した fallback 方針

すべての unresolved subtype を同じ扱いにしない方針です。

「compare mode で unresolved 全部を true に倒す」実験は false positive を増やして失敗しました。ただし、それで subtype 別 fallback の可能性まで否定されるわけではありません。

候補:

- `unknown_sink` は unresolved のまま残す
- `unknown_dfs_limit` の一部だけ `true` に畳む
- subtype と位置に応じた CPU 側 post-rule を入れる

これは試しやすいですが、正当化できる規則が必要です。

### 4. `H(x)` の hot path を軽くする

DFS では今も `h_bound()` 評価が意味のあるコストを占めています。

候補:

- 代数的な簡約
- pass 内キャッシュや再利用
- compare mode 限定の近似

同じ予算を安くできる可能性はありますが、実装コストは高く、数値 drift の危険もあります。

これは unresolved 画素を直接扱う戦略の後で考えるべきです。

### 5. branch ordering を改善する

DFS が、まだ最適でない順に枝をたどっている可能性があります。

より false になりやすい枝を先に訪問できれば、

- 早期終了が増える
- push ノード数が減る
- 形式上の上限を増やさずに実効予算が増える

ただし、対象限定 refinement より改善幅の予測はしにくいです。

### 6. 境界重視のベンチマークを追加する

現在の指標はフルフレーム指標です。

これは有用ですが、不一致のほとんどは細い構造や境界付近に集中しています。境界帯だけを見るベンチマークがあれば、将来の変更が「難しい部分」を改善しているのか、「簡単な部分」を維持しているだけなのかを判断しやすくなります。

候補:

- 参照境界近傍の画素だけを評価する
- 境界帯内の mismatch 密度を記録する
- mismatch 領域近傍の subtype 分布を比較する

これは描画品質そのものというより、測定品質の改善です。

## 推奨優先順位

後で作業を再開する場合の推奨順は次です。

1. GPU 粗判定 + unresolved 画素の CPU 確定
2. unresolved-tile GPU refinement
3. subtype-aware fallback 実験
4. `H(x)` の hot path 最適化
5. branch-order tuning
6. boundary-focused benchmark

理由は単純で、最初の 2 つはすでに出せる情報をそのまま活用できる一方、後ろの方はより投機的な tuning を必要とするからです。
