## 2026-07-25 Actions月枠の逼迫を billing API で実測する共通基盤を追加

同セッションで一度「deploy workflow の run が `skipped` 続きかで枠逼迫を間接判定してよい」と
net-fetch.md に書いたが、ユーザーから「間接判断は危ない」と却下された。妥当な指摘で、あの判定は
**ユーザーが退避スイッチ（`PAUSE_GH_DEPLOY` 等）を入れ忘れていれば「余裕あり」と誤読する**——
逼迫の検出を人間の運用手順の副作用に依存させており、本当に危険なときほど外す。実測に置き換えた。

設計判断（コードに残らない前提）:

- **ai-ops でだけ測る**（`shared/` に置かず consumer へ配布しない）。Actions の月枠は**アカウント単位**で
  `65edh5ih` 配下の private repo が全部同じ枠を共有するので測定は1箇所でよい。加えて ai-ops は public
  なので測定自体が枠を食わない（枠を測るために枠を消費する矛盾を避ける）。consumer に billing PAT を
  配らずに済むのも効く（「consumer に常設トークンを増やさない」原則）。
- **公開先が world-public なので生の使用分数・使用率を出さない**。ai-ops の `ci-logs` は世界公開で、
  アカウントのCI使用状況が晒される。`ok`/`tight`/`exhausted`/`unknown` の band と閾値だけで
  「9割超えたら分散モードを使わない」ルールは成立するため、実数はアカウントの billing 画面に留める。
- **測れなかったら必ず安全側**。token 未設定・API 変更・ネットワーク断・応答形の変化は全部 `unknown` で、
  消費側は `unknown` を `tight` と同じ扱いにする。実装でも2重に塞いだ: (1) `fetch` を try/catch して
  例外で落ちないようにし、(2) それでもスクリプトが結果を残せず落ちた場合に備え workflow 側で
  `unknown` を書く保険ステップを置いた。**これが無いと `ci-logs` に前回の古い `ok` が残り続け、
  消費側が古い ok を掴む fail-open になる**（publish-ci-logs は source-dir が無いと何もせず緑で終わるため）。
- **鮮度も契約に入れた**（`stale_after_hours`・既定24h）。月枠は月初にリセットされ日中に伸びるので、
  古い `ok` を根拠にさせない。ファイル自身に閾値と鮮度を埋めて自己記述にしてある。
- **旧 billing API 優先・enhanced はフォールバック**。「含有枠の何割か」を直接返すのは旧 API だけで、
  enhanced billing platform は金額ベースの明細しか無い。後者では「課金発生＝含有枠超過＝`exhausted`」
  しか断定できず、未課金でも割合は不明なので `ok` と断定せず `unknown` に倒す。どちらの経路が
  このアカウントで生きているかは docs を読んでも確定できなかったため、**両方試して実測で決まる**
  実装にした（初回実行の `source` フィールドに出る）。

閾値90%はユーザー指定。運用中に変えられるよう ai-ops の repo variable
`ACTIONS_QUOTA_THRESHOLD_PCT` で上書き可能にした（未設定なら90）。

検証: billing API をスタブして8ケース実駆動（85%→ok / 89.95%→ok / 90.0%ちょうど→tight /
97.5%→tight / 課金発生→exhausted / 0%→ok / 閾値80に変えて85%→tight / 応答破損→unknown）。
token 未設定・不正tokenの degrade も実行して `unknown` を確認。
