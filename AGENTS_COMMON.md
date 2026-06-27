<!--
種別: 機能追加リクエスト（ai-ops インフラ）
注意: これは共通ブロックの「編集後全文」ではなく、ai-ops 側の collect 機構に
      新しい上り経路を追加してほしいという提案メモです。collect workflow は
      本ファイルを「ファイル上り提案チャネルの新設依頼」として扱ってください。
発信元: 65edh5ih/private
-->

# 提案: `shared/` 実ファイルの上り提案チャネルを新設する

## 背景・動機

現状、consumer → ai-ops の上り経路は **共通ブロック（AGENTS_COMMON.md）のテキスト提案のみ**に整備されている。

- テキスト: `.ai-ops/outbox/` に全文提案を置く → `notify-ai-ops.yml` が `repository_dispatch (outbox-proposal)` を送信 → ai-ops の collect workflow が `AGENTS_COMMON.md` 取り込み PR を生成 → 全 consumer へ再配布。
- 実ファイル（`shared/` 配下、例: `.github/actions/publish-ci-logs/action.yml`）: **上り提案経路が未整備**。AGENTS_COMMON.md 自身が「ファイルの上り提案経路は現状未整備なので、見つけたらユーザーに知らせて ai-ops 側で追加してもらう」と明記している。

この非対称により、`shared/` 配下の composite action 等を直したくなったとき、consumer 側からは提案すら起票できず、ai-ops を直接編集するしかない。テキスト（AGENTS_COMMON.md）と同じ「consumer から提案でき、正本は ai-ops に残る」体験を実ファイルにも広げたい。

## 設計方針（テキスト経路のミラー）

正本はあくまで ai-ops の `shared/` に残す（ドリフト防止のため、consumer のコピーを正本化はしない）。consumer 側に増やすのは**提案の入り口だけ**にする。

### consumer 側（既存をほぼ流用）

- ディスパッチは既存の `notify-ai-ops.yml` が `.ai-ops/outbox/**` への push で汎用 `outbox-proposal` イベントを送っているため、**追加配線は不要**。
- 必要なのは「ファイル提案用の outbox フォーマット」の取り決めのみ。案:
  - ファイル名: `YYYY-MM-DDThhmmss-<短い説明>.md`（既存と同じ。処理順は先頭時刻）。
  - 先頭メタブロックで種別を明示（例: `種別: shared-file-proposal`）、対象パス（`shared/` からの相対）と提案ファイル全文を本文に含める。
  - もしくは提案ファイルそのものを `.ai-ops/outbox/files/<shared-relative-path>` として置く方式でもよい（collect 側がどちらを好むかで決める）。

### ai-ops 側（本体・要実装）

- collect workflow に「ファイル提案」分岐を追加する:
  1. 受信した outbox 提案の種別を判定（テキスト共通ブロック提案 / shared ファイル提案）。
  2. shared ファイル提案なら、提案内容を `shared/<path>` へ反映する取り込み PR を生成。
  3. オーナーがマージしたら、既存の配布経路で全 consumer の対応パスへバイト一致で再配布。
- 安全策の検討:
  - 反映先を `shared/` 配下に限定（パストラバーサル防止）。
  - 提案 diff をそのまま PR にして人間レビューを必須にする（自動マージしない）。

## 完了後にやること（ai-ops 側）

- AGENTS_COMMON.md の「ファイルの上り提案経路は現状未整備なので…ai-ops 側で追加してもらう」という記述を、新チャネルの使い方に差し替える（この更新自体は共通ブロックなので ai-ops が正本）。

## 補足

- 本提案は private 単独では実現できない（重い部分は ai-ops の collect workflow 改修）。private 側からは本メモの起票が上り口の限界。
- 具体的なトリガとなったファイル: `shared/.github/actions/publish-ci-logs/action.yml`（「今後この action を変更するときは ai-ops 側で」と注記されているもの）。
