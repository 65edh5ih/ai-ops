## 2026-08-03 collect-outbox の ci-logs スライスを全件削除

ユーザー依頼で、collect-outbox の CI ログを `latest`・`history` とも全件消した。対象は ops-sync の
公開ロールアップと、詳細ログが出ていた consumer 1件の `ci-logs`（残りの consumer にはスライス自体が
無かった）。**7日 retention を待たずに history が欠けているのは事故ではない**——次のセッションが
「history が欠けている」と調査を始めないようにここに残す。

ci-logs はブランチの先頭を書き換えるだけなので、**ファイルを消しても内容は git 履歴に残る**（public な
ops-sync では削除が削除にならない）。そのため ops-sync 側は先頭からの削除に加えて**ブランチを orphan で
作り直した**（現行ファイルはそのまま・過去のコミットを切り離す）。他の slice の履歴も一緒に失う操作
なので、ci-logs には現在値だけ置く運用（`docs/ci-logs.md`）が前提になっている。到達不能コミットは
しばらく SHA 指定で参照できるため、完全な消去には GitHub サポートが要る点も変わらない。
consumer 側は private なので、作り直しはしていない（先頭からの削除のみ）。

再生成のされ方は**公開ロールアップと詳細ログで違う**。ロールアップは `if: always()` で毎 run 出るので
6時間ごとの cron の次回 run で `latest` が戻るが、詳細ログは `steps.collect.outputs.consumer != ''`
（＝提案を持つ consumer を実際に処理した run）でしか publish されない。提案が無い run・別の consumer を
処理した run では戻らないので、consumer 側の `latest` が数日空くのは正常。恒久的に残したくないなら
slice を消すのではなく publish 側（`.github/workflows/collect-outbox.yml`）を変える必要がある。
