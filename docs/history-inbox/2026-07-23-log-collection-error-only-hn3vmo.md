## 2026-07-23 CI ログ「失敗時のみフル収集」を正本 ci-logs.md に昇格（今後の実装へ引き継ぎ）

- **なぜ**: nikki-san #627 が `collect-deploy-run-logs.yml`（`workflow_run` のフル生ログ collector）を
  `conclusion == 'failure' || 'timed_out'` でゲートし「失敗時のみ回収」に変えたが、この設計原則は
  nikki-san のリポジトリ固有 doc（`docs/ci/CI_LOGS.md` 他）にしか残っておらず、**配布正本
  `shared/docs/ci-logs.md` は未更新**だった。そのため「今後の実装／他 consumer の新規 collector に
  引き継がれるか」を確認したところ引き継がれない状態（正本 step4 は collector に workflow 名を登録する
  としか書いておらず、失敗ゲートに無言）。オーナー依頼で正本へ昇格し全 consumer へ配布する形にした。
- **設計判断**: CI ログは2層で、**混同しないよう正本に明記した**。①inline publish（`publish-ci-logs`,
  各 workflow 末尾 `if: always()`）＝成功・失敗問わず毎回の要約ログ。#627 でも据え置き。②フル生ログ
  collector（`workflow_run` 別 workflow）＝失敗/タイムアウト時のみ。緑 run は①で要約済みで、フル生ログの
  真価は失敗トリアージ。監視対象1完了ごとに最低1分課金のランナーを成功 run でも起こすのは空費
  （2026-07-18 の Actions 分逼迫インシデントの主因の一つ）。①を失敗ゲートしないのは、要約ログは
  成功 run でも回帰調査の一次情報になり、かつ本体ジョブに相乗りで追加ランナー0分だから。
- **展開範囲**: 正本 doc の1点更新のみ。sync が nikki-san / private の `docs/ci-logs.md` へ配布して波及する
  （＝これが「他リポジトリへの展開」の実体）。`private` は collector を持たず inline publish のみのため
  retrofit 対象なし。nikki-san は #627 で適用済み。現時点で個別 consumer への task 起票は不要。
