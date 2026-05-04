# WebGL 位置づけ再整理計画

## 目的

WebGL 実装を削除せずに残しつつ、

- WebGPU を主 UI / 主開発対象
- WebGL を検証用 / 基準実装

として位置づけ直す。

この計画は、UI 改善本体の前提ではなく、その周辺の役割整理を扱う。  
目的は「どちらを主導線に置くか」を現状に即して明文化することにある。

## 現状

現在の構成は次。

- `index.html`
  - WebGPU ビューア
- `webgl.html`
  - WebGL2 ビューア

両者は別 entry のまま残っている。

ただし、役割はすでに対称ではない。

### WebGL の現状

- fragment shader ベースの bounded 実装
- compare の基準線
- `pnpm compare:ref`
- `pnpm compare:ref:640`
の評価対象

### WebGPU の現状

- compute + blit ベースの bounded 実装
- `Display` と `Calculation` を分離した UI を持つ
- `WebGPU Bounded`
- `WebGPU + CPU Refine`
の 2 計算方式を UI 上で選べる
- 今後の UI 改善対象

つまり、現時点ですでに WebGPU 側が主 UI 候補であり、WebGL は基準寄りの役割を持っている。

## ここまでで起きた変化

以前は「mode に何を入れるか」と「どの backend を使うか」が混ざっていた。

現在の WebGPU 側では、少なくとも次が整理された。

- `Display` = 何を描くか
- `Calculation` = どう計算するか

この整理は WebGPU の主 UI 化に沿っている。  
一方、WebGL 側にはまだこの `Calculation` 概念を持ち込んでいない。

これは不整合ではなく、役割差として扱う方が自然である。

## 再整理した結論

### 1. WebGL は残す

これは維持する。

理由:

- compare の基準線として必要
- WebGPU 側改善の比較対象になる
- `img.ppm` 比較系の既存フローがある

### 2. WebGL を主 UI としては扱わない

これも現時点では明確。

理由:

- 今後の UI 改善対象は WebGPU
- `Display` / `Calculation` 分離も WebGPU 側から入っている
- WebGL は state 保持や refinement 実験の中心にはならない

### 3. WebGL / WebGPU を 1 ページ統合しない

少なくとも今はやらない。

理由:

- WebGPU は `Calculation` selector を持つ主 UI
- WebGL は検証用 backend
- 役割が違うものを無理に 1 画面で揃える価値が薄い
- 共通化コストの方が高い

## 方針

### 採る方針

- WebGPU を主 UI とする
- `index.html` は WebGPU 本体を直接起動する入口にする
- WebGL は検証用 / reference 用として残す
- WebGL はユーザー向け導線から外し、検証専用ルートへ退避する

### 採らない方針

- WebGL を削除する
- WebGL を WebGPU と同格の主 UI に戻す
- WebGL / WebGPU / CPU refine を 1 つの selector に無理に統合する

## WebGL に求める役割

今後の WebGL の役割は次に限定する。

- compare 基準線
- WebGPU 改善の回帰確認
- 軽量な reference 実装
- `img.ppm` / `img-640.ppm` に対する比較確認

逆に、次は WebGL に求めない。

- 主導線 UI
- refinement 実験の本体
- `Calculation` selector の受け皿

## WebGPU に求める役割

今後の WebGPU の役割は次。

- 主 UI
- 今後の `y` 平面ウィジェット導入先
- `Display` / `Calculation` 分離を前提にした UI 改善先
- refinement や state 保持の実験先

## README / 導線上の扱い

README では、少なくとも次を明記する状態にする。

- WebGL は compare の基準実装
- WebGPU は主 UI / 主改善対象
- `Display` / `Calculation` は WebGPU 側の概念

また、導線としては次を想定する。

- 起点ページ: `index.html`
- `index.html` で起動するもの: WebGPU 本体
- WebGL: compare / 検証専用ルート

ここでは、`index.html` を単なるランチャーにするのではなく、「アクセスしたらそのまま WebGPU が起動する」状態を採る。

したがって、ユーザー向けの通常導線は

- `/` = WebGPU

で固定する。

一方で WebGL は、比較・検証でのみ使う。

想定例:

- `/webgl.html`
- またはそれに準ずる検証専用パス

ただし、そのルートを README や compare コマンドからは参照できるようにする。

## この課題でやること

### 第1段階

- 文書上で WebGL / WebGPU の役割を固定する
- README と計画書の表現を現状に合わせる
- `index.html` を WebGPU 本体の入口として扱うことを明記する

### 第2段階

- UI 計画書上で、主対象を WebGPU と明示する
- WebGL は `Calculation` selector の選択肢に含めない

### 第3段階

- `index.html` で WebGPU を直接起動する
- WebGL を検証専用ルートへ移す
- トップ導線上から WebGL を外す

## この課題でやらないこと

- WebGL の削除
- WebGL 側への `Calculation` selector 導入
- WebGL / WebGPU の 1 ページ統合

## 判断基準

この計画で固定したい判断は次。

- WebGL は残すべきか
- WebGL は主 UI に残すべきか
- WebGL を WebGPU の `Calculation` selector に含めるべきか
- 1 ページ統合を今やるべきか

現時点の結論は次。

- WebGL は残す
- WebGL は主 UI から外す
- WebGL は `Calculation` selector に含めない
- `index.html` は WebGPU を直接起動する
- WebGL は検証専用ルートからのみ使う
- 1 ページ統合は後回し

## 補足

この課題は、UI 改善本体を進めるための役割整理である。

重要なのは、

- WebGPU に UI 改善を集中すること
- WebGL を比較基準として安定的に残すこと

の 2 点であり、両者を無理に同じ役割へ揃えることではない。
