# WebGPU / WGSL 実装計画

## 進捗サマリ

この文書は引き継ぎ用に更新している。  
以下のステータスを使う。

- `[x]`: 完了
- `[-]`: 着手済みだが未完
- `[ ]`: 未着手

現在の到達点は次。

- `[x]` `vite` 上で `webgpu.html` の別 entry を追加済み
- `[x]` WebGL2 版と別に WebGPU viewer を追加済み
- `[x]` `WGSL` で `x, y, z`、sink、bounded DFS、compare mode を移植済み
- `[x]` Playwright 経由の browser export を WebGPU に対応済み
- `[x]` `img.ppm` との `320x320` 比較が通る
- `[x]` compute pass 分割
- `[x]` per-pixel state を storage buffer に保持する実装
- `[x]` `unknown` を内部状態として扱う 3 値判定
- `[x]` `unknown` 画素の index buffer 取得
- `[x]` `unknown` subtype 分離
- `[-]` `unknown` を使った追加 refinement pass
- `[ ]` `640x640` 基準での常用比較
- `[ ]` 境界再探索

重要な注意:

- 元の計画では WebGPU 版を compute shader 中心で進める想定だった
- ただし現状の初期実装は、まず `render pipeline + WGSL fragment 相当の1-pass` で WebGL2 版と同等挙動を移した段階にある
- したがって、次の担当者は「compute 化そのもの」が次の本命タスクだと理解して進めること

## 目的

現在の WebGL2 fragment shader 版は、比較用の二値出力としてかなり実用的なところまで来ている。  
一方で、細い枝や飛び石的な曲線の再現は、固定長の bounded DFS を fragment shader の中で回す方式では頭打ちが見え始めている。

この計画書では、WebGL2 版を置き換えるのではなく、別実装として WebGPU / WGSL 版を作る方針を定める。

目的は以下。

- より深い探索を扱えるようにする
- 状態を buffer に持ち、探索過程を明示的に扱えるようにする
- 境界付近だけ再計算するなど、段階的な高精度化を可能にする
- 既存の比較基盤をそのまま流用し、`img.ppm` / `img-640.ppm` と定量比較できるようにする

## 現状認識

現状の WebGL2 版では、以下はすでに実装済みである。

- `pnpm + vite` の静的サイト基盤
- WebGL2 による複素数演算
- `z` 計算
- sink 探索
- bounded DFS による比較専用二値出力
- Playwright 経由の browser export
- Node.js による Netpbm 比較

比較結果は良好だが、限界も見えている。

- `320x320` ではかなり高い一致率が出る
- `640x640` でも実用的だが、細い構造の再現には取りこぼしが残る
- fragment shader 内の固定長探索は、精度向上と負荷増大が強く結びついている

つまり、次の改善余地は「定数調整」よりも「実装モデルの変更」にある。

WebGPU 版についての現状認識も追加する。

- `[x]` `webgpu.html` と `src/webgpu-main.js` を追加済み
- `[x]` `src/renderers/webgpu.js` と `src/shaders/webgpu.wgsl` を追加済み
- `[x]` compare mode は WebGL2 版と同じ二値 semantics で動作する
- `[x]` `mode 6` で `unknown` を別色表示できる
- `[x]` `pnpm compare:webgpu:ref` が通る
- `[x]` `window.__maskitTest.getClassificationStats()` を追加済み
- `[x]` `window.__maskitTest.getUnknownPixelIndices()` を追加済み
- `320x320` での比較結果は現状 `mismatchRatio = 0.001201171875`
- `falsePositive = 0`, `falseNegative = 123`
- `[ ]` WebGPU 版専用の高精度化はまだ入っていない
- `[ ]` WebGL2 版を超える一致率や速度改善はまだ未達

## 基本方針

WebGPU 版は compute shader 中心で組む。

- fragment shader に探索全体を押し込まない
- 1 ピクセルごとの状態を storage buffer に持つ
- sink 探索と DFS 判定を compute pass として分離する
- 必要に応じて複数 pass を回し、途中状態を引き継ぐ

初期段階では、既存の WebGL2 版と同じ入力・同じ表示レンジ・同じ比較コマンド体系を保つ。

## 直近の高速化方針

現在の browser hybrid は、精度面では `mismatches = 2` まで詰められている。  
次の優先課題は、CPU 判定そのものの高速化よりも、interactive 表示時の無駄な readback / 再計算を減らすことにある。

方針は以下。

- `[x]` アイドル時の常時再描画を止め、on-demand 描画に切り替える
- `[x]` CPU refine を worker に切り出し、UI thread を止めない
- `[-]` browser hybrid は `unknown` ピクセルだけを CPU 結果で overlay する
- `[ ]` interactive 表示では、可能な限り全画面 `readPixels()` を避ける
- `[ ]` export / compare 時だけ重い全画面経路を許す
- `[ ]` その上で CPU refine 時間と unknown 収集時間を分離計測する

次の改善判断は次の順で行う。

1. interactive path から全画面 readback を外せるか確認する
2. export 専用の重い経路と表示専用の軽い経路をさらに分離する
3. それでも CPU refine が支配的なら、worker 内の実装改善や Wasm を再検討する
4. その後に GPU 側の追加 refinement を再評価する

つまり、直近は `CPU か GPU か` ではなく、

- まず readback / I/O を減らす
- 次に CPU
- 最後に GPU の追加最適化

の順で進める。

## 技術スタック

実装基盤は既存方針を踏襲する。

- パッケージマネージャ: `pnpm`
- アプリ基盤: `vite`
- UI 層: 素の HTML / JavaScript
- GPU API: `WebGPU`
- shader 言語: `WGSL`

既存の比較資産も再利用する。

- `scripts/compare-images.mjs`
- `scripts/render-with-browser.mjs`
- `scripts/compare-with-browser.mjs`
- `img.ppm`
- `img-640.ppm`

## WebGPU 版の到達イメージ

最低限の完成像は以下。

- WebGL2 版とは別の `WebGPU compare mode` がある
- `320x320` と `640x640` で比較コマンドが回る
- sink 探索と DFS 判定が compute pass として分離されている
- 各ピクセルの途中状態を buffer に保存できる
- 将来、境界付近だけ再探索する余地がある

## 実装対象の分解

`BQ.py` の処理は WebGPU 側で以下に分ける。

1. `x, y, z` 初期化
2. sink 探索
3. DFS 判定
4. 二値出力への変換

WebGL2 版と違い、各段階を別 pass に切り出せるので、次のような構成が取りやすい。

- Pass A: ピクセルごとの初期値を構築
- Pass B: sink 探索を実行
- Pass C: DFS 判定を実行
- Pass D: 出力 texture へ書き込む

## データ構造方針

初期実装では、1 ピクセルあたり最低限以下を持つ。

- `x`
- `y`
- `z`
- `a, b, c`
- sink 探索回数
- DFS 用 stack pointer
- DFS 用 visit count
- 現在の判定状態

必要なら、後でこれを 2 層に分ける。

- 常に必要な per-pixel state
- DFS 専用の一時バッファ

## 判定モデル

最初の WebGPU 版では、いきなり完全な厳密化を目指さない。

まずは以下を目標にする。

- WebGL2 版と同等以上の compare mode を出す
- 同じ探索予算でも、WebGL2 版より安定して深い探索ができる
- `unknown` を内部状態として持てる

判定状態は内部的には subtype を分けて持つ。

- `0`: false
- `1`: true
- `2`: `unknown_sink`
- `3`: `unknown_dfs_limit`
- `4`: `unknown_stack`

表示時には用途に応じて切り替える。

- compare mode では用途に応じて二値化規則を持つ
- デバッグ mode では `unknown` subtype を別色で出す

最終段階ではさらに 2 系統の出力を持つ前提にする。

- 比較 / 最終二値出力では、Python 互換性を見ながら `unknown` subtype ごとに扱いを分ける
- ただしデバッグ表示では、最後まで `unknown` だった画素を `unknown` のまま残して描画する mode を維持する

つまり、`unknown` は最終的に消すのではなく、

- 数値比較用の二値化経路
- 調査用の 3 値可視化経路

の両方を残す。

## 第1段階: 最小 WebGPU compare mode

最初の段階では、比較可能な最小系を作る。

### 1-1. WebGPU 初期化

- `[x]` adapter / device 取得
- `[x]` canvas context を `webgpu` で初期化
- `[x]` 出力 texture を確保
- 補足:
  - 現在は `src/renderers/webgpu.js` で `render pipeline` と `copyTextureToBuffer` を使っている
  - compute shader 専用の土台はまだない

### 1-2. 初期値 compute pass

- `[-]` `x` を複素平面へ写像
- `[-]` 固定 `y` を受け取る
- `[-]` `z` を計算する
- `[ ]` per-pixel state buffer へ保存する
- 補足:
  - これらの数式自体は `src/shaders/webgpu.wgsl` に移植済み
  - ただし compute pass と storage buffer ではなく、現在は fragment 相当の1-passで処理している

### 1-3. sink 探索 compute pass

- `[-]` WebGL2 版と同等の sink 探索を移植
- `[-]` 途中で `abs < 0.5` へ落ちたら false
- `[ ]` sink 後の `a, b, c` を state buffer に戻す
- 補足:
  - sink 探索ロジック自体は移植済み
  - buffer ベースの状態保持はまだ未着手

### 1-4. 二値出力 pass

- `[x]` compare mode を出す
- `[x]` browser export と比較スクリプトがそのまま通る
- `[x]` `true -> black`, `false -> white` の可視 semantics を WebGL2 版と揃える

この段階での目標は、「WebGPU 経路が end-to-end で動くこと」である。

この目標は達成済み。

## 第2段階: DFS の compute 化

この段階が本命である。

### 2-1. 明示スタック方式

各ピクセルに対して、DFS を明示スタックで回す。

- `[-]` 再帰は使わない
- `[ ]` stack buffer 上で `(a, b, c, depth)` を保持する
- `[ ]` `visit count` と `depth` の両方で budget を管理する
- 補足:
  - 現在の WGSL 実装には bounded DFS がある
  - ただし shader 内ローカル配列で持っており、compute pass / storage buffer 化は未実装

### 2-2. 判定結果の保存

- `[-]` false が確定したら即停止
- `[-]` stack が空になれば true
- `[x]` budget 超過は `unknown` として保持
- 補足:
  - 現在は `unknown_sink` / `unknown_dfs_limit` / `unknown_stack` を分けている
  - ただし subtype 別件数の集計はまだ未実装

### 2-3. compare mode との接続

compare mode ではまず以下を採る。

- `[x]` true -> black
- `[x]` false -> white
- `[x]` unknown -> white

デバッグ mode では以下を維持する。

- `[x]` true -> black
- `[x]` false -> white
- `[x]` `unknown_dfs_limit` -> 赤
- `[x]` `unknown_stack` -> 紫
- `[x]` `unknown_sink` -> 黄

補足:

- 現在は `mode 6` で `unknown` を別色表示している
- compare mode では現時点で `unknown` はすべて white 側に倒している
- `unknown_dfs_limit -> true` を試すと compare は悪化したため保留
- 今後 refine / finalize pass を追加した後も、この 3 値可視化 mode は残す

これで既存の `P1` 基準と比較しやすくする。

## 第3段階: WebGPU ならではの改善

WebGPU 版に移る意味はここにある。

### 3-1. 境界再計算

1 回目の判定結果を見て、境界候補だけ budget を増やして再計算する。

候補抽出の基準例:

- 近傍 8 ピクセルと判定が異なる
- visit count が上限近い
- unknown が出た

現状:

- `[x]` `unknown` の可視化 mode はある
- `[x]` `unknown` 画素の index buffer は取れる
- `[x]` `unknown` subtype は `sink / dfs_limit / stack` で分離済み
- `[ ]` subtype 別件数の集計はまだない
- `[ ]` `unknown_dfs_limit` のみを対象にした refine pass はまだない

実装方針:

1. 通常 budget で全画素を判定する
2. `unknown` を subtype 別に集計する
3. `unknown_dfs_limit` だけを別バッファへ収集する
4. `unknown_dfs_limit` だけ高 budget で再判定する
5. compare / 最終二値出力とデバッグ表示で扱いを分ける

- `[ ]` 未着手

### 3-2. 低解像度プレビュー + 高解像度確定

- ドラッグ中やズーム中は低解像度
- 停止後に高解像度 / 高予算で再計算

現状:

- `[ ]` 未着手

## 直近の最適化方針

現時点では、WebGPU の既定値 `64 / 192 / 2048` でブラウザ体感が約 `fps 8` である。  
これ以上、全画素へ一律に予算を増やすのは効果に対して重い。

したがって次の最適化方針は以下。

1. `unknown` の subtype 別件数を取る
2. `unknown_dfs_limit` のみを refinement 対象にする
3. refinement pass は全画面走査ではなく `unknownIndices` ベースにする
4. compare 用 preset と通常閲覧用 preset を分ける

現時点では、予算引き上げと subtype 分離により次まで改善済み。

- baseline: `mismatchRatio = 0.0019921875`, `falseNegative = 204`
- current: `mismatchRatio = 0.001201171875`, `falseNegative = 123`

### 3-3. 中間状態の可視化

- sink iteration count
- DFS visit count
- unknown 分布
- `H(x)` 近傍の不安定領域

現状:

- `[ ]` 未着手

## UI 方針

WebGPU 版の UI は既存 UI を極力流用する。

追加・変更が必要なのは以下。

- renderer 切り替え
  - `WebGL2`
  - `WebGPU`
- compare mode
- sink / DFS budget
- debug mode の切り替え

比較や計測が主目的なので、UI は増やしすぎない。

現状:

- `[x]` WebGPU 版は WebGL2 版と同じ HUD 構成を別 entry で持っている
- `[ ]` 同一ページ内での renderer 切り替え UI はまだ入れていない

## 計測方針

WebGPU 版では、WebGL2 版より計測を重視する。

最低限ほしい値は以下。

- browser export 1 回あたりの wall time
- pass ごとの GPU 実行時間
- `320x320` と `640x640` の比較時間
- budget を上げたときの増加率

これにより、DFS 深さや visit 数を感覚でなく計測で決める。

現状:

- `[x]` wall time は browser export 結果として確認できる
- `[x]` CPU 時間は viewer HUD で確認できる
- `[ ]` WebGPU pass ごとの GPU 実行時間
- `[ ]` compute pass 化後の詳細計測

## 比較・検証方針

既存の比較コマンドを流用しつつ、WebGPU 版専用コマンドを追加する。

候補:

- `[x]` `pnpm compare:webgpu:ref`
- `[ ]` `pnpm compare:webgpu:640`

最低限の確認項目は以下。

- `320x320` で WebGL2 版以上の一致率が出るか
- `640x640` で細い構造の取りこぼしが減るか
- wall time が許容範囲か
- `unknown` を使った再探索余地が残るか

## 実装順序

1. `[x]` WebGPU renderer の土台を作る
2. `[-]` canvas へ単純な compute 出力を表示する
3. `[-]` `x, y, z` 初期化 pass を作る
4. `[-]` sink 探索 pass を移植する
5. `[x]` compare mode を出す
6. `[x]` Playwright export を WebGPU に対応させる
7. `[x]` `320x320` 比較を通す
8. `[ ]` bounded DFS を compute pass 化する
9. `[ ]` `640x640` 比較を通す
10. `[ ]` 境界再探索や unknown 可視化を追加する

## 当面やらないこと

最初の WebGPU 版では、以下は後回しでよい。

- 派手な UI 変更
- 3D 的な可視化
- 完全な CPU 厳密一致
- 複数 `y` の同時計算
- worker への分離

## 判断基準

以下を満たせば、WebGPU 版へ移行する価値がある。

- `640x640` で WebGL2 版より一致率が高い
- 細い構造の取りこぼしが減る
- budget を増やしたときに改善余地が見える
- browser export と比較コマンドが既存フローのまま回る

逆に、以下なら WebGPU 版の設計を見直す。

- pass 分割しても改善しない
- buffer 管理だけ複雑になって一致率が上がらない
- 計測上、予算を増やしても境界構造が回収できない

## 最初の1手

最初の 1 手はこれでよい。

1. `[x]` WebGPU renderer の初期化だけを追加する
2. `[ ]` `WebGL2 / WebGPU` 切り替えを UI に足す
3. `[-]` compute pass で `x, y, z` のデバッグ表示を出す
4. `[x]` browser export が WebGPU 経路でも取れるようにする

この 4 つが通ったら、次に sink 探索 pass を移す。

引き継ぎ時点での次の1手は以下に更新する。

1. `src/renderers/webgpu.js` を render pipeline 依存から切り離し、storage buffer を持つ compute pass 構成へ切る
2. `x, y, z` 初期化を compute pass 化する
3. sink 探索を state buffer 更新型に置き換える
4. compare mode の出力 texture 書き込みを最終 pass に分離する
