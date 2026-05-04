# UI 改善計画

## 目的

Maskit ビューアの UI を、単なるデバッグ入力群から、観察・比較・実験を整理して行える操作系へ再設計する。

今回の整理で特に重要なのは次の 2 点。

- 複素数パラメータ `y` を平面上の点ドラッグで調整できるようにする
- 「何を表示するか」と「どう計算するか」を UI 上で明確に分離する

ただし、後者の「表示モード / 計算方式の分離」は UI 改善本体の前提作業であり、別タスクとして先行実施する。

本計画書は、その前提が整理された後に行う UI 改善本体を扱う。

## まず整理すべき認識

これまで `mode` という語が曖昧に使われていた。

しかし本来は、次の 2 軸を分けるべき。

### 1. 表示モード

これは「何を描くか」を指す。

現状の典型例:

- 複素平面座標
- `z` 成分
- `|z|`
- 判別式
- `H(x)` の枝判定
- `BQ` の最終二値分類

### 2. 計算方式

これは「どう計算するか」を指す。

候補例:

- WebGL bounded
- WebGPU bounded
- WebGPU + CPU refine

補足:

- `WebGPU unresolved-tile refine` は過去に試した実験案として文書上には残す
- ただし現状では UI の正式選択肢には入れない

この 2 軸を UI で混ぜると、`mode 7 = hybrid compare` のような不自然な構造になり、表示モードと計算パイプラインが衝突する。

今回の UI 改善では、ここを明確に分ける。

## 現状整理

前提:

- `mode` / `solver` 分離そのものは、別計画として先に処理する
- 本書では、その分離後の UI 構成を扱う

現状の UI は、主 UI である `index.html` と検証用の `webgl.html` にあり、主な入力は次。

- `mode`
- `y.real`
- `y.imag`
- `render-width`
- `render-height`
- `maxSinkIters`
- `maxDfsDepth`
- `maxDfsVisits`
- `Reset View`
- `Export PPM`
- `Apply Size`
- メイン canvas 上での pan / zoom

WebGPU 側には追加で次がある。

- `solver`
- `Show CPU Refine Preview`
- CPU refine 系の補助状態

ただし、これらは表示モードではなく「補助表示」または「計算方式の副作用」であり、`mode` の一部として扱うのは適切ではない。

## 必須要件

### 1. 複素数パラメータ `y` は平面上の点として操作する

これは最重要要件。

必要条件:

- `y = y.real + i * y.imag` を 2D 平面上の点として表示する
- 点をドラッグすると `y.real` と `y.imag` が同時に更新される
- 実軸・虚軸・原点・グリッドを表示する
- 現在値が常に読める
- 数値入力による微調整も残す

### 2. 表示モードと計算方式を別 UI にする

表示モード:

- 何を描くかを選ぶ

計算方式:

- どの solver / pipeline を使うかを選ぶ

この分離は必須。

### 3. 高度な設定は主操作から分離する

通常観察時に毎回触らない項目は、同列に並べない。

対象:

- 描画サイズ
- 探索 budget
- 比較・デバッグ補助

## 新しい UI 構造案

### A. 主操作

常時見せる項目。

- 表示モード
- 計算方式
- `y` パラメータ平面
- `y.real`, `y.imag` の微調整入力
- `Reset View`
- `Export PPM`

### B. 表示範囲操作

canvas 側の直接操作。

- pan
- zoom

これは従来どおりメイン canvas 上で行う。

### C. 高度設定

折りたたみ前提。

- `render-width`
- `render-height`
- `maxSinkIters`
- `maxDfsDepth`
- `maxDfsVisits`

### D. 補助表示・デバッグ

必要時のみ見せる項目。

- CPU refine preview の有無
- classification 統計
- refine の状態表示

ここは表示モードとは別扱いにする。

## 表示モードの整理案

表示モードは「何を描くか」に限定する。

候補:

- `Complex Plane Coordinates`
- `Markoff z Components`
- `Markoff |z|`
- `Quadratic Discriminant`
- `H(x) Branch Test`
- `BQ Binary Classification`

補足:

- unresolved の色分けは、将来的に「表示モード」ではなく「オーバーレイ表示」または「補助表示」に寄せる方が自然
- したがって、以前の `Unknown highlight` 系は mode 本体から外す方針にする

## 計算方式の整理案

計算方式は別 selector で持つ。

候補:

- `WebGPU Bounded`
- `WebGPU + CPU Refine`

意味:

- `WebGL Bounded`: WebGL の fragment shader ベース bounded 実装
- `WebGPU Bounded`: WebGPU の compute + blit ベース bounded 実装
- `WebGPU + CPU Refine`: unresolved を CPU 側で再評価する経路

重要:

- これは mode ではない
- compare 系表示でも、計算方式は独立に切り替えられるべき

現時点で UI に正式に出す候補は次の 3 つに限定する。

- `WebGPU Bounded`
- `WebGPU + CPU Refine`

`Tile Refine` は、実験経路として文書には残すが、UI の正式な選択肢には入れない。

## 複素数パラメータ UI 草案

### `y` パラメータ平面

表示内容:

- 実軸
- 虚軸
- グリッド
- 現在の `y` 点
- 範囲ラベル

操作:

- ドラッグで `y` 更新
- ダブルクリックで既定値へ戻す
- 必要なら modifier key で微調整

補助表示:

- `y = a + bi`
- 現在座標

### 数値入力

`y.real`, `y.imag` は残す。

理由:

- 厳密値を入れたい場合がある
- compare 用に再現性のある座標指定が必要

### 廃止候補

- `y.real slider`
- `y.imag slider`

理由:

- 複素数を 2 本の独立 slider で扱うのは不自然
- 平面 UI と数値入力があれば十分

## パラメータ列挙

### 共通状態

- `mode`（表示モード）
- `solver` または `calculationMode`（計算方式）
- `y.real`
- `y.imag`
- `offsetX`
- `offsetY`
- `scale`
- `render-width`
- `render-height`
- `maxSinkIters`
- `maxDfsDepth`
- `maxDfsVisits`

### WebGPU 固有の補助状態

- unresolved 可視化フラグ
- hybrid overlay 状態
- classification stats
- refine timing

注意:

これらは mode ではなく、補助状態または計算方式依存状態として扱う。

## レイアウト草案

### 草案 1: メイン HUD + 折りたたみ詳細

常時表示:

- 表示モード
- 計算方式
- `y` 平面
- `y.real`, `y.imag`
- Reset / Export
- ステータス要約

折りたたみ:

- Render Size
- Search Budget
- Debug / Diagnostics

利点:

- 主操作が明確
- 現状の HUD 構造から移行しやすい

### 草案 2: 左 HUD + 右詳細パネル

左:

- 表示モード
- 計算方式
- `y` 平面

右:

- 数値入力
- Search Budget
- Render Size
- Diagnostics

利点:

- 役割分離が明確

欠点:

- 占有面積が増える

## 推奨案

最初に採るなら草案 1。

理由:

- 既存 UI の延長で入れやすい
- まず概念整理を優先できる
- `y` 平面を主役にしつつ、高度設定を邪魔にならない位置へ移せる

## 改善案

ここでは実装に入らず、次の変更方針だけを記す。

### 改善案 1: `mode` と `solver` を UI 上で分離する

やること:

- `mode` は表示モードだけに限定
- 新たに `solver` または `calculation mode` を追加

期待効果:

- `hybrid` や `CPU refine` の位置づけが明確になる
- 今後 WebGPU の別計算方式を増やしても UI が破綻しにくい

### 改善案 2: `y` slider を `y` 平面に置き換える

やること:

- `y.real slider`
- `y.imag slider`
を削除し、複素平面ウィジェットを追加

期待効果:

- 複素数パラメータとして自然になる
- 実部・虚部を別々にいじる不自然さを減らせる

### 改善案 3: 高度設定を折りたたむ

やること:

- Render Size
- Search Budget
- Diagnostics
を折りたたみ化

期待効果:

- 通常観察時のノイズを減らせる
- 主操作の視認性が上がる

### 改善案 4: unresolved 系表示を mode から外す

やること:

- unresolved 可視化は mode ではなく overlay / debug toggle に寄せる

期待効果:

- 表示モードの意味が一貫する
- compare と debug の関係がわかりやすくなる

### 改善案 5: WebGL / WebGPU の説明を UI 上でも分離する

やること:

- 計算方式 selector の説明を付ける
- WebGL と WebGPU の違いを HUD かヘルプに短く出す

期待効果:

- 今見ている結果が、表示モード差なのか計算方式差なのかがわかりやすくなる

## 段階的な進め方

### 第1段階

- `y` 平面ウィジェット追加
- 数値入力との双方向同期

### 第2段階

- 高度設定の折りたたみ
- diagnostics の再配置

### 第3段階

- unresolved overlay の UI 再整理
- WebGPU 専用補助表示の整備

## 今回の結論

現状の混線は、「表示モード」と「計算方式」を同じ `mode` に押し込もうとしたことが原因だった。

今後の UI 改善本体では次を原則にする。

- `mode` は何を描くか
- `solver` はどう計算するか
- `y` は平面上の点として操作する

その前段として、`mode` / `solver` 分離を別タスクとして先に完了させる。
