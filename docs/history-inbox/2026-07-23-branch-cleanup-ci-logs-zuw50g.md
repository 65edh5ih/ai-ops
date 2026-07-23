## 2026-07-23 branch-cleanup workflow に publish-ci-logs を後付け（Codex P2 / #63 の抜け）

#63 で追加した branch-cleanup workflow が、共通必須ルール「新規 `.github/workflows/` には publish-ci-logs で
CI ログ出力を組み込む」（`docs/ci-logs.md`）を満たしておらず、private の sync 生成 PR #397 で Codex P2 が指摘。
初版は stdout と `$GITHUB_STEP_SUMMARY` にしか出しておらず、削除結果・失敗が ci-logs ブランチに残らなかった。

対処: 正本 `shared/.github/workflows/branch-cleanup.yml`（＋ai-ops 自身のバイト一致コピー）に、docs/ci-logs.md の
手順どおり (1) `permissions: contents: write`（既存）、(2) 本体ログを `logs/ci/scripts/branch-cleanup.log` へ tee、
(3) 末尾に「Stage CI log snapshot」＋「Publish logs to ci-logs branch」を `if: always()` で追加。inline publish
（常時）層のみ。フル生ログ collector への登録は**リポジトリ固有**なので shared には入れない（collector を持つ repo
だけ、その workflows 一覧に失敗時ゲートで足す＝各 repo 側の follow-up）。

学び: 新規 workflow を書くときは docs/ci-logs.md を先に読む（#63 で読み飛ばした）。shared 配布の workflow は
全 consumer に同じ抜けが伝播するので、共通必須ルールの充足はマージ前に確認する。
