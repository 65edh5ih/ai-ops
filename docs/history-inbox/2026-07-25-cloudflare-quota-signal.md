## 2026-07-25 Cloudflare 月枠の信号を追加（`actions-quota` の対）

GitHub Actions の枠が尽きたときの退避先は Cloudflare だが、**CF 側にも月枠がある**（Free: Pages の
ビルド 500回/月・Workers Builds 3,000分/月・ともにアカウント単位）。GitHub 側だけ見て自動退避すると
今度は CF を溶かして「どこにもデプロイできない」に至るので、対になる信号を作った。将来の
`*_DEPLOY_POLICY=auto` の突合が読む前提。

### 実測で分かった、設計を変えた事実

この信号は**先に手で測ってから**設計した。推測で作っていたら間違えていた点が3つある:

1. **枠を消費しない deployment が圧倒的多数**。2026-07 の Pages は deployment 2,079 件のうち課金対象は
   **94 件（4.5%）**だけだった。除外すべきは `deployment_trigger.type == "ad_hoc"`（`wrangler pages deploy`
   ＝Direct Upload。CF のビルド枠を使わない）と、watch paths 不一致で `is_skipped: true` になったもの。
   単純に deployment を数えていたら **20 倍以上**過大評価していた。
2. **使用率だけでは判断できない**。同じ月内で日次レートが不連続に変わる——実測の日次分布は
   `7/19: 32 → 7/20: 32 → 7/21: 14 → 7/22: 5 → 7/23: 3 → 7/24: 6 → 7/25: 2` で、watch paths を絞った
   前後で 10 倍以上違う。そこで**直近 N 日（既定7）の窓**でレートを出し、残枠が月末まで持たなければ
   `tight` にする。**月累計 ÷ 経過日数の平均は使わない**（設定変更の前後をまたぐと実態とずれる）。
   - このセッションで実際に、私は「94 件 ÷ 推定1日 = 94件/日」と外挿して「7/29 に枯渇する」と誤報告した。
     切替日を run 履歴から推測したのが誤りで、実際は7日分だった。**平均レートの罠**そのものなので、
     実装では窓方式を採った。
3. **Workers Builds の「分」は API が返さない**。`running_on`〜`stopped_on` から算出する推定値で、
   Cloudflare の課金定義と一致する保証は無い。桁の把握には足りるが、閾値には余裕を持たせる前提で使う。

### fail-closed の作り

`actions-quota` と同じく、測れなければ必ず `unknown`（消費側は逼迫扱い）。加えてこの信号固有の穴として
**ページングが進まないと黙って過少カウント＝fail-open になる**（＝「まだ余裕がある」と誤って言う）ので、
同じ先頭要素が返り続けたら `unknown` に倒す。数値設定（上限・閾値・窓）が壊れていたら既定へ黙って
戻さず `unknown`——`actions-quota` で踏んだ「`NaN` で割ると `pct >= threshold` が常に false」と同型。

### トークンの置き場

**ai-ops は public** なので、ここに置く CF トークンは**読み取り専用に限る**。切替（Pages の自動デプロイ
反転・watch paths 変更）に要る Edit 権限の操作は、consumer 側の workflow が自分のトークンで行う。
なお Workers Builds API は **user-scoped トークン必須**（account-scoped は "Invalid token"）なので、
public repo に user-scoped トークンを置くことになる——read-only である点が担保。
アカウント ID も secret で持つ（public repo のログに出さないため）。

### 全体 state は最悪値に揃える

`pages_builds` と `workers_build_minutes` の悪いほうを全体 state にする（片方でも逼迫していれば
「CF へ退避してよい」とは言えない）。リソース別の state も併記する——退避先として使えるのが
どちらかで、消費側の判断が変わるため。

検証: CF API をスタブして24ケース実駆動（各リソースの ok/tight/exhausted、閾値未満でも直近レートで
月末超過なら tight、ad_hoc と skip の除外、先月分の除外、片方 tight/unknown のときの全体 state、
exhausted > unknown の優先順、ページング停滞、各種取得失敗、Workers Builds 未接続の 404、
token/account 未設定、数値設定の typo、上限変更）。**生の数値を publish していないことも各ケースで検査**。
