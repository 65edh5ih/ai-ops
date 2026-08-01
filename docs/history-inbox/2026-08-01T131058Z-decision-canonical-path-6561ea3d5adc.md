## 2026-08-01 decision を設計 doc の正本パスに publish する

### なぜこの作業が発生したか

`deploy-route-reconcile.yml` の `publish-ci-logs` が `dest: deploy-route/latest` を指しており、
**設計 doc・同 workflow の冒頭コメント・`scripts/deploy-route-reconcile.mjs` の3つが揃って
「出力は `deploy-route/decision.json`」と書いているのに、実際にはそこに無い**状態だった。
consumer（nikki-san / private の admin worker）は正本パスと現在の publish 先の**両方を試す**
実装なので動いてはいたが、正本が 404 のままなのは事実が2つある状態。

### 判断・制約

- **他の slice と違って `<name>/latest` にしない**。この slice は人が読むログではなく
  **consumer の worker が URL 直打ちで取りに来る配布物**で、URL が3箇所の doc/コードに
  書かれている。publish 先だけ慣習に寄せると正本パスが 404 のまま誰も気づかない。
  「なぜ `/latest` が付いていないのか」を後から `/latest` に戻されないよう、workflow に
  理由をコメントで残した。
- `publish-ci-logs` は `rm -rf ${DEST}` してから書くので、`dest: deploy-route` にすると
  **古い `deploy-route/latest/` は自動的に消える**（history-dir は未設定なので巻き添えは無い）。
- consumer 側の fallback（`latest/`）は**残す**。決め打ちにすると publish 先が動いた瞬間に
  404 で自動切替が黙って止まるため、どちらの順で直しても切れ目が出ない形を保つ。
  ただし consumer のコメントが「publish 側はいま latest に出している（是正待ち）」という
  **時点依存の書き方**だったので、時点に依存しない書き方へ直した（別リポジトリの PR）。

### 分かったこと（次に効く）

- **「設計 doc と実装が食い違っている」型の欠陥は、動作テストでは出ない**。今回も consumer が
  両パスを試すおかげで無症状だった。doc に書いた URL が実在するかは、doc とコードの
  **文字列一致**で見るしかない（`grep -rn "deploy-route/" --include=*.md --include=*.yml --include=*.mjs`
  で4箇所すべてが出るので、そこが一致しているかを見る）。
