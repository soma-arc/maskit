# 表示モード / 計算方式 分離計画

## 目的

UI 改善本体に入る前に、現在混線している

- 表示モード
- 計算方式

を明確に分離する。

これは UI 改善の前提タスクであり、別建てで先に完了させる。

## 背景

これまで `mode` が複数の意味で使われていた。

本来は次の 2 つを分けるべき。

### 表示モード

何を描くか。

例:

- 複素平面座標
- `z` 成分
- `|z|`
- 判別式
- `H(x)` の枝判定
- `BQ` の最終二値分類

### 計算方式

どの solver / pipeline で判定するか。

例:

- WebGL bounded
- WebGPU bounded
- WebGPU + CPU Refine

この 2 つを混ぜると、`mode 7 = hybrid compare` のように「表示」と「計算」が 1 個の selector に押し込まれ、UI と内部構造の両方が歪む。

## 現状認識

現状のコードと文書には、次の痕跡がある。

- `mode` が表示モードを指す箇所
- `mode` が計算方式まで含んでいた過去の痕跡
- `hybrid` という曖昧な呼び方
- `showGpuUnknown` のような補助表示フラグ

整理すると、現在の実体はこう。

### 現在の表示モード

UI に出すべきもの:

- `Complex Plane Coordinates`
- `Markoff z Components`
- `Markoff |z|`
- `Quadratic Discriminant`
- `H(x) Branch Test`
- `BQ Binary Classification`

### 現在の計算方式

概念として区別すべきもの:

- `WebGL Bounded`
- `WebGPU Bounded`
- `WebGPU + CPU Refine`

### UI に出さないもの

- `WebGPU Tile Refine`

理由:

- 実験はしたが、現状では実用に足る結果が出ていない
- 文書には残すが、UI の正式経路には入れない

## このタスクでやること

### 1. 用語を固定する

用語は次に統一する。

- `displayMode`
  - 何を表示するか
- `solver` または `calculationMode`
  - どう計算するか

使わない方がよい語:

- `hybrid`
  - 曖昧なので原則使わない

置き換え:

- `hybrid` → `WebGPU + CPU Refine`

### 2. UI 上の selector を分ける

必要な selector:

- 表示モード selector
- 計算方式 selector

役割:

- 表示モード selector
  - shader / 可視化内容の切り替え
- 計算方式 selector
  - WebGL / WebGPU / CPU refine の経路切り替え

### 3. 内部 state を分ける

state の概念も分離する。

例:

- `displayMode`
- `solver`
- `showUnknownOverlay`

ここで `showUnknownOverlay` は mode ではなく補助表示状態として扱う。

### 4. 文書の語彙を合わせる

対象:

- README
- UI 計画書
- 実装メモ
- 検証結果メモ

少なくとも次を揃える。

- mode = 表示モード
- solver = 計算方式
- `WebGPU + CPU Refine` を正式名称にする

### 5. UI に出すもの / 出さないものを明確化する

UI に正式に出す:

- `WebGL Bounded`
- `WebGPU Bounded`
- `WebGPU + CPU Refine`

UI に出さない:

- `WebGPU Tile Refine`
- 過去の `mode 6/7` 系の名残

補助表示としてのみ扱う:

- unresolved / unknown 可視化

## 完了条件

このタスクの完了条件は次。

1. `mode` が表示モードだけを指す
2. 計算方式が別概念として state と UI に現れる
3. `hybrid` という曖昧語が UI から消える
4. `WebGPU + CPU Refine` が正式名称になる
5. `Tile Refine` は UI に出ず、文書上の実験案に留まる

## 現状判定

WebGPU 側では、この計画の主目的はすでに達成している。

- `mode` は表示モードだけを指す
- `solver` が別 selector として存在する
- `WebGPU + CPU Refine` が正式名称になっている
- `Tile Refine` は UI に出していない

残っているのは命名上の仕上げだけである。

- `mode` を `displayMode` に改名するか

これは意味の混線を解消するための改善案としては妥当だが、現時点では `mode` がすでに表示専用に収束しており、必須ではない。
したがって、現段階では「将来の任意リファクタリング項目」として扱う。

## 改善案

### 改善案 1: `mode` を `displayMode` に改名する

利点:

- 意味が明確
- 今後の混線を防ぎやすい

懸念:

- 既存コードの置換範囲が広い

### 改善案 2: `solver` を新設する

候補値:

- `webgl-bounded`
- `webgpu-bounded`
- `webgpu-cpu-refine`

利点:

- 今後 solver を増やしても UI 設計が壊れにくい

### 改善案 3: unresolved 可視化を overlay 扱いにする

利点:

- 表示モードが「何を見るか」に集中できる
- compare と debug を分けやすい

### 改善案 4: compare を表示モード側に残し、solver を独立させる

例:

- 表示モード: `BQ Binary Classification`
- 計算方式: `WebGPU + CPU Refine`

利点:

- 「二値分類を見る」という表示意図と
- 「どう計算したか」という実装意図を
別々に保てる

## 実装順序

### 第1段階

- 用語の固定
- 文書上の概念整理

### 第2段階

- state の分離
- UI selector の分離

### 第3段階

- 補助表示フラグの整理
- `hybrid` 名残の除去

### 第4段階

- UI 改善本体へ進む
- `y` 平面ウィジェット導入
- 高度設定の折りたたみ

## この計画の位置づけ

これは UI 改善本体ではない。

役割は、UI 改善本体に入る前に概念と語彙を整理し、以後の実装で同じ混線を起こさない土台を作ることにある。
