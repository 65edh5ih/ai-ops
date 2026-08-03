## 2026-08-03 collect-outbox の ci-logs スライスを全件削除

ユーザー依頼で、collect-outbox の CI ログを `latest`・`history` とも全件消した。対象は ops-sync の
公開ロールアップと、詳細ログが出ていた consumer 1件の `ci-logs`（残りの consumer にはスライス自体が
無かった）。**7日 retention を待たずに消えているのは事故ではない**——次のセッションが「history が
欠けている」と調査を始めないようにここに残す。

ci-logs はブランチの先頭を書き換えるだけなので、**削除しても内容は git 履歴に残る**（public な
ops-sync では削除が削除にならない。ci-logs ブランチの README に既出）。今回はノイズの掃除として
先頭からの削除に留め、履歴からの消去（orphan での作り直し）は他スライスの履歴も巻き添えにするため
行っていない。機微の除去が目的なら作り直しが要る。

collect-outbox は 6時間ごとの cron なので、次回 run で `latest` が再生成される。恒久的に残したくない
なら slice を消すのではなく publish 側（`.github/workflows/collect-outbox.yml`）を変える必要がある。
