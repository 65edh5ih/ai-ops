# CI ログ運用（組み込みと、失敗時の切り分け）

CI ログは AI エージェント専用なので `main` を汚さない専用ブランチ `ci-logs`（main から分岐・orphan）へ
slice 単位で publish する。このための composite action `.github/actions/publish-ci-logs` は **ops-sync が全 consumer へ
配布する共通インフラ**（`shared/` 同期。手で編集しない）。

## いつ使うか（トリガ）

- **`.github/workflows/` に新しいワークフローを追加するとき**（→ 手順A）。組み込みは全リポジトリ共通の義務。
- **CI が失敗して原因を調べ始めるとき**（→ 手順B）。ログの在り処より先に「そもそもジョブが走ったか」を見る。

## 前提・パラメータ

- **公開先**: 実行したリポジトリの `ci-logs` ブランチ。private リポジトリのものは非公開、public
  リポジトリ（ops-sync 等）のものは**世界公開**になる——後者に機微を出さない（MUST NOT）。
- **`ci-logs` は恒久ログ専用**。追記型なので**ファイルを消しても内容は git 履歴に残る**（public
  リポジトリでは削除が削除にならない）。よって「現在値を読ませ続けるもの」（CI ログ・quota 信号）だけを
  置き、**読んだら用済みの一次データを混ぜない**（MUST NOT）。後者は専用の揮発ブランチへ出す
  （例: net-fetch の結果 → `net-fetch-results`。`publish-ci-logs` ではなく `publish-ephemeral` を使う）。
- **2層構成**（使い分けは全リポジトリ共通）:
  - **inline publish**（手順A-3）… 各ワークフローが**毎 run 常時**、自前の要約ログを公開する。
  - **フル生ログ collector**（手順A-4）… `workflow_run` で完了 run の生ログ全体を集約する別ワークフロー。
    **失敗時のみ**回収する。
- **collector・ログ設計ドキュメントのファイル名や有無はリポジトリ固有**（各 `AGENTS.md` の固有パートに書く）。
- **エージェントに要る能力**: 対象リポジトリの `ci-logs` ブランチを読めること、および手順B では
  **run のページ（または run/check の annotation）を読めること**——ジョブ一覧と usage だけでは足りない
  （手順B-2 の理由）。

## 手順A: 新規ワークフローに CI ログ出力を組み込む

1. ジョブに `permissions: contents: write` を付ける。
2. スクリプトログを `logs/ci/scripts/<name>.log` へ出す（`2>&1 | tee`）。
3. ジョブ末尾に「Stage CI log snapshot」と「Publish logs to ci-logs branch」
   (`uses: ./.github/actions/publish-ci-logs`) の2ステップを `if: always()` で足す（＝この inline 公開は
   成功・失敗を問わず常時）。**手順3は例外なく全ワークフローで必須**。
   - 完了条件: 成功 run・失敗 run のどちらでも `ci-logs` に当該 slice が作られる。
4. リポジトリにフル生ログ collector があるなら、その `workflows` リストにワークフロー名を登録する。
   **collector は失敗時のみ回収する（MUST）**——ジョブの `if:` を
   `github.event.workflow_run.conclusion == 'failure' || github.event.workflow_run.conclusion == 'timed_out'`
   でゲートする。比較は**各値ごとに完全形で書く（MUST NOT: `== 'failure' || 'timed_out'` と略す）**——GitHub Actions 式では
   非空文字列 `'timed_out'` が常に真に評価され、成功 run でもゲートを通り抜けて失敗ゲートが無効化されるため。
   緑の run は手順1〜3 で inline に要約ログを公開済みで、フル生ログの真価は失敗トリアージにある。監視対象が
   1つ完了するごとに最低1分課金されるランナーを成功 run でも起動するのは空費（過去に GitHub Actions 分の
   逼迫を招いた実例あり）。collector を**新規に作る**場合も同じ失敗ゲートを付ける（MUST）。
   - 完了条件: 成功 run で collector が起動しないこと（Skipped になる）を1回確認できている。
   - **登録の例外**: **リクエスト単位で毎 run の一次情報を自前で publish** するワークフロー
     （現状 `net-fetch`。結果を専用の揮発ブランチ `net-fetch-results` の `net-fetch/<request_id>/` と
     ジョブログへ `if: always()` で常時出す）は collector に**登録しない**。理由: (1) status/response の
     一次情報は毎 run 自前で出ている、(2) job 失敗は主に「取得先が到達不能」等の**期待される失敗**で
     インフラバグではなく、失敗ゲートの collector を毎回起こすのはノイズ・課金（2026-07-18 の分逼迫と
     同種）。この例外に当たるかは「毎 run 自前で一次情報を出しており、失敗が想定内か」で判断する。
5. リポジトリにログ設計ドキュメントがあるなら、その slice 一覧テーブルに行を足す（collector 由来の
   スライスは「失敗/タイムアウトした run のみ」と明記する）。
   - 完了条件: 手順1〜5 が同一 PR に入っている。

## 手順B: CI 失敗の切り分け（ログを読み始める前に）

1. **その run でジョブが1つでも起動したかを見る**（ジョブ一覧の件数と、run の usage の `billable`）。
   - 完了条件: 「ジョブが走った」か「ジョブ0件・課金0分」かが確定している。
2. **ジョブが走っていれば**、通常どおりログを読む（inline slice → 失敗なら collector のフル生ログ）。
3. **ジョブ0件・課金0分だった場合**は、**run のページ（または run/check の annotation）に出ている文言を
   必ず読む**（MUST）。ジョブが起動していない原因は少なくとも3種類あり、**ジョブ数と課金だけでは区別
   できない**（MUST NOT: 件数だけで原因を断定する）:

   | run ページの文言 | 原因 | 対処 |
   |---|---|---|
   | `Invalid workflow file`・式や `uses:` の参照エラー | **ワークフロー側の不具合**（構文・式・reusable workflow の参照）。**直前の自分の変更が原因**でありうる | ワークフローを直す |
   | `Internal server error. Correlation ID: …` | GitHub 側の一過性障害 | 再実行してよい |
   | 支払い・枠に関する文言 | アカウント側の実行拒否（枠切れ・spending limit） | 復旧を待つ（→ `docs/actions-quota.md`） |

   - 完了条件: 上記のどれに当たるかが**run ページの文言に基づいて**確定している。
4. **ワークフローを変更した直後の失敗は、まず自分の変更を疑う**（MUST）。「ジョブ0件だから
   ワークフロー側ではない」は**誤り**——構文・式の不正はジョブ生成前に弾かれるので、まさにこの見え方になる。

## よくある失敗

- **ジョブ0件を「外部要因」と即断する**: 3種類のうち1つは**ワークフロー側の不具合**で、しかも
  自分が直前に触ったときに最も起きやすい。手順B-3 の文言確認を飛ばさない。
- **同時に複数のワークフローが同じ壊れ方をしたのを根拠にアカウント側と断定する**: アカウント側を
  *示唆*するが決め手ではない。GitHub の内部障害も同じ push の run をまとめて巻き込むし、共通の
  reusable workflow を壊せばワークフロー側でも同時多発する。文言で裏を取る。
