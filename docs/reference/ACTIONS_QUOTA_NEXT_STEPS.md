# Actions 月枠の使用率算出（enhanced billing 経路）を完成させる手順

`actions-quota` は現在このアカウントで **`ok` / `tight` を出せず `unknown` のまま**で、当初要件
（「月枠の9割を超えたら private repo での自発 dispatch を止める」）を満たしていない。これを満たすまでの手順。

## いつ使うか（トリガ）

- `ci-logs` の `quota/actions.json` が `source` に `enhanced:*` を出しつつ `state` が `unknown` のままで、
  private リポジトリでの自発 dispatch を通せるようにしたいとき。
- 適用外: `state` が `ok` / `tight` / `exhausted` を出せているとき（この作業は済んでいる）。
  `source` が `none` のときも対象外——それは PAT 未設定か API 障害で、`README.md` のセットアップ手順5を見る。

## 前提・パラメータ

- **作業対象は ai-ops のみ**。`scripts/actions-quota.mjs` と `.github/workflows/actions-quota.yml` は
  ai-ops 専用で `shared/` に無く、consumer へは配布されていない。consumer 側の
  `docs/actions-quota.md` 等は配布コピーなので**手編集しない**（MUST NOT）。
- **エージェントに要る能力**: ai-ops をセッションから参照・編集できること、ai-ops の workflow を
  `workflow_dispatch` で起動できること、ai-ops の `ci-logs` ブランチを読めること。
  満たせないときは停止してユーザーに依頼する（MUST）。
- **現状の実測値**（2026-07-25・PAT 登録後の初回実行）:
  `{"state":"unknown","source":"enhanced:users","note":"enhanced billing API exposes cost, not % of included minutes; ..."}`
  → このアカウントは **enhanced billing platform 側**で、含有枠に対する使用分数を直接返す旧 API
  （`/users/{user}/settings/billing/actions`）は 200 を返さない。
- **確定していること / していないこと**を混同しない:
  - 確定: 旧 API が使えないこと。**現在の実装**が `netAmount`（金額）しか見ておらず、そのため割合を
    出せないこと。
  - **未確認（仮説）**: enhanced API の `usageItems[]` に分数量（`quantity` / `unitType: "Minutes"`）が
    含まれること。**実レスポンスを見て確かめるまで、これを前提に実装しない**（MUST NOT）。

## 手順

1. **enhanced API の実レスポンス形状を確認する**。対象は
   `GET /users/{account}/settings/billing/usage`（`ACTIONS_QUOTA_TOKEN` と同等の Plan:Read-only 権限が要る）。
   確認するのは「Actions の使用量を表すフィールドが存在するか」「その単位は何か」「当月ぶんをどう絞るか」。
   - **実数を公開経路に出さない**（MUST NOT）。ai-ops の `ci-logs` と Actions の run ログは世界公開なので、
     生レスポンスをそこへ publish しない。ローカル実行か、非公開の場所で確認する。
   - 完了条件: 使用量フィールドの名前・単位・当月の絞り方が分かっており、**分数量が取れるのか取れないのか
     が確定している**。取れないと分かった場合は手順2以降を実装せず、ユーザーに報告して方針を相談する（MUST）。
2. **含有枠の分数の持ち方を決める**。含有枠（Free 2,000／Pro 3,000 等）は API が返さないので設定値が要る。
   閾値と同じく repo variable で上書きできる形にする（例 `ACTIONS_QUOTA_INCLUDED_MINUTES`）。
   - **`(0, 上限]` の有限数以外は `unknown` に倒す検証を必ず入れる**（MUST）。しきい値で同じ穴
     （`Number('9O')` が `NaN` になり判定が常に false ＝ fail-open）を実際に踏んでいる。
   - 完了条件: 未設定・不正値のとき `unknown` になることをローカル実行で確認できている。
3. **使用率の算出を実装する**。OS 別の課金倍率（Windows 2倍・macOS 10倍）が使用量フィールドに反映済みか、
   単価側で表現されているかを手順1の結果で判断し、**どちらの解釈を採ったかをコード内コメントに残す**
   （MUST。取り違えると使用率が数倍ずれ、しかも気づけない）。
   - 完了条件: `state` が使用率に応じて `ok` / `tight` を返す。
4. **境界と fail-closed の回帰確認**。billing API をスタブして、しきい値ちょうど・しきい値未満・課金発生・
   応答形が壊れているケースを実駆動する。
   - 完了条件: しきい値以上 → `tight`、未満 → `ok`、課金発生 → `exhausted`、応答破損・token 未設定 →
     `unknown` が**すべて**再現する。
5. **実環境で1回流す**。ai-ops の `actions-quota` workflow を `workflow_dispatch` で起動する
   （**git ref は既定ブランチ `main` を指す**。MUST）。
   - 完了条件: `ci-logs` の `quota/actions.json` が `ok` か `tight` を返し、`checked_at` が更新されている。
6. **doc とタスク履歴を更新する**（MUST）。
   - `shared/docs/actions-quota.md` の「既知の制限」の注記を**実態に合わせて書き換えるか削除する**
     （現在形で書く原則。直らないまま注記だけ残す/直ったのに残すのはどちらも不可）。
   - この doc（`ACTIONS_QUOTA_NEXT_STEPS.md`）は役目を終えるので**削除を提案する**（腐った手順は残さない）。
   - `docs/history-inbox/` に「なぜその解釈を採ったか」を1ファイル置く（→ `docs/task-history.md`）。
   - 完了条件: 上記3点が同一 PR に入っている。

## 壊してはいけない不変条件

既存の設計判断（`docs/ops-sync-design.md` の「Actions 月枠の信号」節・
`docs/history-inbox/2026-07-25-actions-quota-billing-signal.md` に経緯）を崩さないこと:

- **測れなかったら必ず `unknown`**（＝消費側は逼迫扱い）。「たぶん余裕がある」で `ok` を出さない（MUST NOT）。
  `fetch` の try/catch と、workflow 側の保険ステップ（結果が残らなかったときに `unknown` を書く）は
  どちらも fail-open を塞ぐためのもので、外すと `ci-logs` に前回の古い `ok` が残り続ける。
- **生の使用分数・使用率を publish しない**（MUST NOT）。出すのは band と閾値だけ。
- **ai-ops でだけ動かす**。`shared/` に移して consumer へ配布しない（枠はアカウント単位なので測定は
  1箇所でよく、public な ai-ops なら測定自体が枠を消費しない。consumer に billing PAT を配らない）。
- workflow の `run:` に `${{ vars.* }}` 等を直接埋めない（MUST NOT。env 経由。注入経路になる）。

## よくある失敗

- **未確認の仮説を前提に実装する**: 「`quantity` があるはず」で書き始めると、無かったときに手戻りする。
  手順1で確定させてから2以降に進む。
- **公開経路に実数を出す**: デバッグで生レスポンスを run ログや `ci-logs` に出すと、アカウントの
  CI 使用状況が世界公開に落ちる。消しても git 履歴に残る。

## 関連ファイル

| パス | 内容 |
|---|---|
| `scripts/actions-quota.mjs` | 測定ロジック（**主対象**） |
| `.github/workflows/actions-quota.yml` | 6時間ごとの実行と publish |
| `shared/docs/actions-quota.md` | 消費側の手順（SOP）。判定の意味を変えるならここも直す |
| `shared/docs/ops-sync-design.md`「Actions 月枠の信号」節 | 設計判断 |
| `docs/history-inbox/2026-07-25-actions-quota-billing-signal.md` | 経緯（統合後は `docs/AI_TASK_HISTORY.md`） |
| `README.md` セットアップ手順5 | secret の権限・登録先 |
| 出力先 | `ci-logs` ブランチの `quota/actions.json` と `quota/actions-quota.log` |
