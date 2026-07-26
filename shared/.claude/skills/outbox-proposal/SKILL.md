---
name: outbox-proposal
description: 全リポジトリ共通ルール（AGENTS.md のマーカー区間）や同期配布ファイル（docs/ の配布 doc・sync-manifest 記載ファイル）の修正提案、他リポジトリへの作業依頼（task）・タスク消化報告（task-done）を出すときの手順。同期対象のファイルを手で直したくなったら必ずこれを使う。
---

`docs/outbox-proposal.md` を読み、その書式で `.ops-sync/outbox/` に提案ファイルを置く。

例外: ops-sync リポジトリ自身の中では outbox を使わず、正本を直接編集する（ops-sync の AGENTS.md 参照）。
