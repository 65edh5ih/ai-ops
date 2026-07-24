# CI ログ運用（新規ワークフローを追加するとき）

CI ログは AI エージェント専用なので `main` を汚さない専用ブランチ `ci-logs`（main から分岐・orphan）へ
slice 単位で publish する。このための composite action `.github/actions/publish-ci-logs` は **ai-ops が全 consumer へ
配布する共通インフラ**（`shared/` 同期。手で編集しない）。

**新規に `.github/workflows/` を追加するときは必ず CI ログ出力を組み込む**（この義務自体は全リポジトリ共通）。
新規ワークフローを足すときにこのドキュメントを読み、次の手順を踏む:

1. ジョブに `permissions: contents: write` を付ける。
2. スクリプトログを `logs/ci/scripts/<name>.log` へ出す（`2>&1 | tee`）。
3. ジョブ末尾に「Stage CI log snapshot」と「Publish logs to ci-logs branch」
   (`uses: ./.github/actions/publish-ci-logs`) の2ステップを `if: always()` で足す（＝この inline 公開は
   成功・失敗を問わず常時。各 workflow が自前の要約ログを毎回残す層）。
4. リポジトリにフル生ログ collector（`workflow_run` で完了 run の生ログ全体を集約する別 workflow）が
   あるなら、その `workflows` リストにワークフロー名を登録する。**collector は失敗時のみ回収する（MUST）**
   ——ジョブの `if:` を
   `github.event.workflow_run.conclusion == 'failure' || github.event.workflow_run.conclusion == 'timed_out'`
   でゲートする。比較は**各値ごとに完全形で書く（MUST NOT: `== 'failure' || 'timed_out'` と略す）**——GitHub Actions 式では
   非空文字列 `'timed_out'` が常に真に評価され、成功 run でもゲートを通り抜けて失敗ゲートが無効化されるため。緑の run は上の 1〜3 で各 workflow が
   inline に要約ログを公開済みで、フル生ログの真価は失敗トリアージにある。監視対象が1つ完了するごとに
   最低1分課金されるランナーを成功 run でも起動するのは空費（過去に GitHub Actions 分の逼迫を招いた実例あり）。
   collector を**新規に作る**場合も同じ失敗ゲートを付ける（MUST）。
5. リポジトリにログ設計ドキュメントがあるなら、その slice 一覧テーブルに行を足す（collector 由来の
   スライスは「失敗/タイムアウトした run のみ」と明記する）。

> collector・設計ドキュメントの**ファイル名や有無はリポジトリ固有**（各 `AGENTS.md` の固有パートに書く）。
> 上記の「publish-ci-logs を組み込む」義務、および**2層の使い分け**（inline publish＝常時／フル生ログ
> collector＝失敗時のみ）は全リポジトリ共通。

> **collector 登録の例外**: **リクエスト単位で毎 run の一次情報を inline publish** するワークフロー
> （現状 `net-fetch`。結果を `net-fetch/<request_id>/` に `if: always()` で常時公開）は、collector（手順4）に
> **登録しない**。理由: (1) status/response の一次情報は inline に常時残る、(2) job 失敗は主に「取得先が到達
> 不能」等の**期待される失敗**でインフラバグではなく、失敗ゲートの collector を毎回起こすのはノイズ・課金
> （2026-07-18 の分逼迫と同種）。新規ワークフローがこの例外に当たるかは「毎 run 自前で一次情報を inline
> publish し、失敗が想定内か」で判断する。手順3（inline publish）は例外なく全ワークフローで必須。
