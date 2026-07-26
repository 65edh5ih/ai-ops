---
name: outbox-proposal
description: 全リポジトリ共通ルール（AGENTS.md のマーカー区間）や同期配布ファイル（docs/ の配布 doc・sync-manifest 記載ファイル）を直すとき、他リポジトリへの作業依頼（task）・タスク消化報告（task-done）を出すときの手順。ops-sync 正本への直接 PR と outbox 提案のどちらを使うかもここで決める。同期対象のファイルを手で直したくなったら必ずこれを使う。
---

`docs/outbox-proposal.md` を読み、経路（ops-sync 正本への直接 PR / `.ops-sync/outbox/` への提案）を
選んでから、その書式で直す。

例外: ops-sync リポジトリ自身の中では outbox を使わず、正本を直接編集する（ops-sync の AGENTS.md 参照）。
