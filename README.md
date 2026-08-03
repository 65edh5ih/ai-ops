# ci-logs

`main` から独立した**恒久ログ専用**のブランチ（orphan）。AI エージェントが読むための CI ログ・
月枠の信号を slice 単位で置く。`main` の履歴を汚さないために分けてある。
仕組みと運用は `main` の [`shared/docs/ci-logs.md`](../../blob/main/shared/docs/ci-logs.md)
（consumer では `docs/ci-logs.md`）。

## 置くもの

| slice | 中身 |
|---|---|
| `quota/actions/` | GitHub Actions 月枠の band 信号（`actions.json`。全リポジトリのエージェントが読む） |
| `quota/cloudflare/` | Cloudflare 月枠の band 信号（`cloudflare.json`） |
| `sync/<consumer>/` | 同期 workflow の実行ログ |
| `collect-outbox/` | outbox 取り込みの件数ロールアップ |
| `archive-task-history/<repo>/` | タスク履歴バッチの件数ロールアップ |
| `branch-cleanup/` | このリポジトリのブランチ掃除ログ |
| `codex-review-inbox/` | Codex レビュー在庫の件数ログ |

## このブランチは履歴を持たない（消す必要が出たら作り直す）

**ops-sync は public なので、ここに出したものは世界公開の恒久記録になる**（ファイルを消しても
git 履歴に残る＝削除が削除にならない）。よって出してしまったログを本当に消すときは、ファイルの
削除では足りず、**orphan で作り直して過去のコミットごと切り離す**。他の slice の履歴も一緒に
失う操作なので、現行ファイルだけ残ればよいと確認できたときに限る。
直近の作り直しは 2026-08-03（`collect-outbox/` のログを全件削除した分を履歴から読めなくするため）。

現在は**公開先を「そのログが何についてのログか」で決める**: 対象リポジトリの中身に由来する詳細ログは
**対象リポジトリ自身の `ci-logs`** へ publish し、ここ（ops-sync）には**件数・repo 名・成否・PR URL まで**の
ロールアップだけを置く。ここに出してよい上限はこの粒度（`shared/docs/ci-logs.md` 手順A-6）。

> 注: git の到達不能コミットはしばらく SHA 指定で参照できる。完全な消去が要る場合は GitHub サポートへの
> 依頼が必要。
