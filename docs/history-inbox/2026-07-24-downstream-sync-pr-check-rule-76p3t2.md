## 2026-07-24 配布変更のダウンストリーム（consumer 同期 PR）確認ルールを AGENTS.md に追加

net-fetch 配布の一連で、**ai-ops 本体の PR には出ず consumer 同期 PR でだけ出る Codex 指摘**があった
（#68 では出ず nikki-san#636 でスクリプト注入 P1、private#401 で PEM・クエリの指摘）。ユーザーが3つの PR を
挙げてくれて初めて拾えた。これを取りこぼすと配布物の欠陥が全 consumer に残るため、shared/ を触るセッションが
下流を確認する運用を明文化した（当初検討した常駐ウォッチャー Routine は、`create_trigger` 経由の fresh セッションに
github connector が渡らず機能しないため、代替としてセッション主導の確認ルールにした）。

実態の確認（今回計測）:
- 同期 PR（head `ai-ops/sync-common`）は **MERGE_MODE=direct で作成から約2秒で自動マージ**される
  （nikki-san#639 / private#404 とも created と merged がほぼ同時刻）。
- Codex は**マージ後**の同期 PR を数分後にレビューしうる（#636/#401 はマージの1〜4分後にレビューが付いた）。
  一方 #639/#404 はレビューが付かなかった（Codex は best-effort・非決定的）。
- したがってルールは「open な同期 PR を待つ」ではなく「**マージ済み同期 PR の Codex レビュー・CI を数分後に見る**」。

ルール（`AGENTS.md`「配布変更のダウンストリーム確認」）:
- 配布変更 PR は自分の PR を購読し、マージ後に consumer の最新同期 PR（`consumers.txt` の各 repo）の Codex/CI を確認。
- consumer 確認には `add_repo`(read) が要る → エージェント起点で勝手に追加せず**ユーザー承諾を得てから**（AGENTS_COMMON 準拠）。
- 指摘は **ai-ops 正本で修正**（consumer PR は手編集しない）。同一ファイル配布なので1回の正本修正で全 consumer 分が直る。
- outbox 由来の取り込み PR は提案元セッションが居ないので、取り込み PR を扱うセッションが同手順で行う。

参考: #71 の配布（#639/#404）は今回チェック済みで Codex 指摘・CI 失敗とも無し（net-fetch の実修正は #71 本体で
Codex レビュー済みのため上流で vetted）。
