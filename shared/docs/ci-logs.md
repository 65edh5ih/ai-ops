# CI ログ運用（新規ワークフローを追加するとき）

CI ログは AI エージェント専用なので `main` を汚さない専用ブランチ `ci-logs`（main から分岐・orphan）へ
slice 単位で publish する。このための composite action `.github/actions/publish-ci-logs` は **ai-ops が全 consumer へ
配布する共通インフラ**（`shared/` 同期。手で編集しない）。

**新規に `.github/workflows/` を追加するときは必ず CI ログ出力を組み込む**（この義務自体は全リポジトリ共通）。
新規ワークフローを足すときにこのドキュメントを読み、次の手順を踏む:

1. ジョブに `permissions: contents: write` を付ける。
2. スクリプトログを `logs/ci/scripts/<name>.log` へ出す（`2>&1 | tee`）。
3. ジョブ末尾に「Stage CI log snapshot」と「Publish logs to ci-logs branch」
   (`uses: ./.github/actions/publish-ci-logs`) の2ステップを `if: always()` で足す。
4. リポジトリにログ collector（`workflow_run` で集約する workflow）があるなら、その `workflows` リストに
   ワークフロー名を登録する。
5. リポジトリにログ設計ドキュメントがあるなら、その slice 一覧テーブルに行を足す。

> collector・設計ドキュメントの**ファイル名や有無はリポジトリ固有**（各 `AGENTS.md` の固有パートに書く）。
> 上記の「publish-ci-logs を組み込む」という義務自体は全リポジトリ共通。
