# ai-ops 作業履歴

ai-ops での作業の「**なぜ**」の記録。書き方・アーカイブは共通規約 [`task-history.md`](task-history.md) に従う
（consumer に影響する変更・内部だけの変更の区別なくここ1箇所 → [`AGENTS.md`](../AGENTS.md)「履歴ファイル」節）。

---

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

### Codex レビューで塞いだ穴（いずれも「安全側に倒すはずが倒れない」系）

- **しきい値の typo で fail-open（P1）**: `Number('9O')` は `NaN` で `pct >= NaN` が常に false になり、
  **使用率にかかわらず `ok` を publish していた**。100超の値も同じく判定が発火しない。しきい値は
  private repo の dispatch を認可する値なので、`(0,100]` の有限数以外は `unknown` に倒すよう検証を追加。
  併せて `threshold_pct` に必ず妥当な数を載せる（`NaN` は `JSON.stringify` で `null` になり消費側が読めない）。
- **workflow の `run:` に `${{ vars.* }}` を直接埋めていた**: このリポジトリの鉄則（注入経路になる）違反で、
  かつ非数値が混ざると actions.json が壊れて消費側が読めなくなる。env 経由＋数値サニタイズに変更。
- **CI ログを残していなかった（P2）**: `docs/ci-logs.md` の手順2-3（`logs/ci/scripts/<name>.log` への tee と
  snapshot の publish）は「例外なく全ワークフローで必須」。net-fetch の例外は collector 登録（手順4）だけで
  ログ出力の免除ではない、と読み違えていた。`unknown` の理由（権限/応答形/ネットワーク）を切り分けるには
  ログが要る。publish 先が世界公開なので token 形の伏字も入れた。
- **SOP の導線不足（P1）**: doc のトリガを「private repo の workflow を自発 dispatch するとき」と
  net-fetch より広く書いたのに、導線が net-fetch.md からのリンクだけだった。広いトリガに合わせて
  `AGENTS_COMMON.md` の1節と skill ラッパーを追加。
- **正本 doc の更新漏れ（P1）**: 新 secret を足したのに README のセットアップ手順と ops-sync-design の
  Secret 表を直しておらず、再構築時に `ACTIONS_QUOTA_TOKEN` が未設定のまま＝全 consumer の自発 dispatch が
  永久に止まる状態になっていた。AGENTS.md の完了手順（仕組みを変えたら両 doc を更新）どおり反映。

## 2026-07-25 含有枠の出どころを経路ごとに正す（consumer 同期 PR の Codex 指摘）

ai-ops#87 で「含有枠はどちらの API も返さないので設定値で持つ」と書いたが**誤り**。旧 billing API は
`included_minutes` を返し、コードもそれを使っている（設定値を分母にするのは enhanced 経路だけ）。
doc だけが実装と食い違っていた。放置すると「旧 API が使えるアカウントでも設定値を合わせないと
誤判定する」と読まれ、無用な変数設定を促すか、逆に旧 API の実値が無視されていると誤解される。

あわせて「プランを変えたらこの値も更新する」を **MUST** に格上げした。`docs/sop-format.md` が
「キーワードの付いていない文は説明であって要求ではない、という前提で読まれる」と定めているため、
太字の地の文では要求として読まれない。この値が古いまま大きすぎると `ok` を出しすぎ、
課金される dispatch を通してしまうので、強度は MUST が正しい。

**この2件は ai-ops 本体の PR には出ず、consumer 同期 PR（nikki-san#669）にだけ Codex 指摘として出た。**
AGENTS.md の「配布変更のダウンストリーム確認」が想定しているとおりの取りこぼし経路で、
マージ後に同期 PR を見に行っていなければ全 consumer に誤った doc が残っていた。

## 2026-07-25 Actions月枠の実測は enhanced billing 側で未完（unknown 固定）と判明

PAT 登録後の初回実測で `source: enhanced:users` が判明。**このアカウントは enhanced billing platform 側**で、
含有枠に対する使用分数を直接返す旧 API が使えない。enhanced API は金額ベースの明細しか返さないため、
実装の enhanced 経路は「課金発生＝exhausted / 未課金＝unknown」の二択しか出せず、**当初要件（9割超えで
止める）を満たしていない**。

放置の是非: `unknown` は安全側（逼迫扱い）に倒れるので危険はないが、private repo での自発 dispatch が
永久に止まる。安全だが何も動かせない状態なので残作業として明示した。

残作業と壊してはいけない不変条件は `docs/reference/ACTIONS_QUOTA_NEXT_STEPS.md` に切り出した
（別セッションへの引き継ぎ用に1ファイルへ集約。パスだけ渡せば cold start でも追えるようにした）。
併せて配布 doc `shared/docs/actions-quota.md` にも既知の制限として注記した——消費側が `unknown` を見て
「壊れているから無視してよい」と誤判断すると fail-closed の意味が消えるため、止まる挙動自体は意図どおりだと
明記している。

学び: 「どちらの API 経路が生きているか」は docs からは確定できず、**実際に叩くまで分からなかった**
（docs.github.com は enterprise-cloud 版へリダイレクトする）。両方試して source を記録する実装にしておいた
ことで、PAT 登録の初回実行だけで確定できた。外部 API の分岐は推測で片方に決め打ちせず、実測で確定する
作りにしておくと後が楽。

## 2026-07-25 引き継ぎdocを SOP 化し、「未確認の仮説を断定で書いた」矛盾を正した

ai-ops#85 で作った `docs/reference/ACTIONS_QUOTA_NEXT_STEPS.md` への Codex レビュー3件に対応。
うち1件は**自分が書いた2つの文書が矛盾している**という指摘で、根っこは確認していないことを断定で
書いたことだった。

- **矛盾（P2・最重要）**: 配布 doc には「enhanced API は金額ベースの明細しか返さない」と書き、
  引き継ぎ doc には「`usageItems[]` の `quantity` を合算すれば分数が出るはず」と書いていた。前者は
  「割合算出は原理的に不可能」と読め、後者の計画と食い違う。**実際に確定しているのは「現在の実装が
  金額しか見ていない」ことだけ**で、`quantity` の有無は実レスポンスを見ていないので未確認。両 doc とも
  「確定/未確認」を書き分ける形に直し、手順1で確定させてから実装に進む構成にした。
  教訓: 外部 API の応答形を推測で断定しない。断定は実測した事実にだけ使う。
- **SOP 化（P1）**: cold start のエージェントに実装させる目的の doc なので `docs/sop-format.md` が適用される。
  散文の「やること」を、トリガ・前提・番号付き6ステップ（各ステップに検証可能な完了条件）・よくある失敗の
  構成に書き直した。最終ステップに「この doc 自体の削除提案」と「配布 doc の既知の制限注記の更新」を
  入れてある——直ったのに注記が残る/直らないのに消える、のどちらも防ぐため。
- **consumer から辿れないリンク（P2）**: 配布 doc から `docs/reference/...` をリポジトリ相対で参照していたが、
  この doc は ai-ops ローカルで consumer には配布されない。consumer のエージェントが自分の repo を探して
  見つからない状態だったので、public な ai-ops の絶対 URL に変えた。**`shared/` から ai-ops ローカルの
  パスを相対参照しない**（配布先で壊れる）。

### 追記: 既存ルール「配布変更のダウンストリーム確認」を実行し忘れた

ai-ops 本体の PR には出ず、**nikki-san#667 / private#421 の同期PRにだけ**追加指摘が出た。

**これは新しい発見ではない。** `AGENTS.md`「配布変更のダウンストリーム確認（shared/ を触ったら下流も見る）」
（52-64行目）に、この事象も対処も既に書いてある——「Codex は**マージ後の同期 PR を数分後にレビューする
ことがあり**、ai-ops 本体の PR に出ず consumer 同期 PR でだけ出る指摘がある」「マージ後に consumer の
最新同期 PR を確認する」、過去に net-fetch 配布で同じことが起きた実例まで載っている。**そのルールを
実行しなかった**のが今回の問題で、ユーザーに指摘されて初めて見に行った。

- **事実誤り（private#421・P2）**: 配布 doc の注記に「`state` が `unknown` のまま」と書いたが、
  enhanced 経路でも**課金が検出されれば `exhausted` を出す**ので偽。正しい契約は「課金検出＝`exhausted`、
  未課金＝`unknown`」。`exhausted` を見た運用者を「そんな状態は出ないはず」と誤らせるところだった。
- **日付スナップショット（nikki-san#667・P1）**: 「（2026-07-25 時点）」の注記は運用 doc の現在形ルール違反
  （incidents・タスク履歴以外は現在形）。日付付きの状態記述は履歴側に置き、doc には現在の契約だけを書く。
  → 注記ブロックを丸ごと削除し、内容を「測定側の構成」節へ現在形で溶かした。
- **同一 doc 内の言い残し（ai-ops#86・P2）**: 冒頭の注記だけ「現在の実装が」と限定に直したのに、下の
  「測定側の構成」節に `後者は金額しか出ない` という元の断定が残っていた。**同じ主張が複数箇所にあるとき、
  1箇所直して満足しない**（grep で全部潰す）。
- **手順が実行不能（ai-ops#86・P2）**: 手順1（応答形の確認）は、登録済み secret を読み戻せず公開経路も
  禁止しているため、列挙した前提だけでは cold start のエージェントが着手できなかった。作業用 PAT を
  別途受け取ることと、非公開の確認場所を用意することを前提に明記し、無ければ停止して依頼する形にした。

**なぜ実行し忘れたか**（同じ踏み方を避けるため）: PR がマージされた時点で「完了」と扱ってしまった。
マージ通知は購読解除を伴うので**終わった感**が強いが、ルール上はマージこそが下流確認の**開始**トリガである。
`shared/**`・`AGENTS_COMMON.md` を触った PR は、マージ通知を受けた時点で consumer の最新
`ai-ops/sync-common` PR を見に行くところまでが1セット。数分あけて見る必要があるので、マージ時に
`send_later` を仕込むのが確実（ルール側にもその指示がある）。

今回の内訳: 指摘4件のうち3件が consumer 同期PR由来で、うち1件は**配布済みの doc に載った事実誤り**
（`exhausted` を出す経路があるのに「`unknown` のまま」と書いた）。取りこぼしていたら全 consumer に
誤った記述が残っていた。ルールが警告していたとおりの結果になった。

## 2026-07-25 Actions月枠の使用率算出（enhanced billing 経路）を完成させる

`docs/reference/ACTIONS_QUOTA_NEXT_STEPS.md` の引き継ぎ手順に沿った作業。判断根拠を残す。

- **含有枠は設定値で持つしかない**（API が返さない）。既定は GitHub Free の 2,000 分（ユーザー確認済み）で、
  repo variable `ACTIONS_QUOTA_INCLUDED_MINUTES` で上書きする。**不正値は既定へ黙ってフォールバックさせず
  `unknown` に倒す**——typo した上書き値を既定で置き換えると「設定したつもりの枠と違う枠で測った ok」を
  publish しうる。`Number('2OOO')`＝`NaN` で割ると使用率が `NaN` になり `pct >= threshold` が常に false ＝
  使用率にかかわらず ok を出す fail-open で、これは `AQ_THRESHOLD` で実際に踏んだ穴と同型。
  上限 1,000,000 分の sanity check は分と秒の取り違え等の桁違いを弾くため（含有枠は最大でも
  Enterprise の 50,000 分程度）。
- **引き継ぎ doc が挙げていた「private リポジトリで publish せずに実レスポンスを確認する」案は使えない**。
  それ自体がエージェント自発の private repo dispatch であり、`quota/actions.json` が `unknown` の間は
  `docs/actions-quota.md` が禁止している行為そのもの（枠の状態を測るために枠のガードを破る循環）。
  実レスポンスの確認はユーザーのローカル実行で行った。
- **API 仕様の裏取りは net-fetch の集約モードで行った**（`docs.github.com` がセッションの egress で 403）。
  public な ai-ops 上の実行なので枠を消費せず、取得対象も公開ドキュメントで機微でない。
- **`quantity` は「素の実行分数」と解釈した**（引き継ぎ doc が「取り違えると数倍ずれる」と警告していた分岐）。
  根拠は実レスポンスの `pricePerUnit` が SKU 別（Linux の分単価が単独の値として出る）で、GitHub の公表単価も
  Linux:Windows:macOS = 1:2:10 の比＝**倍率は価格側で表現されている**こと。よって含有枠の消費は
  `quantity × OS倍率` で数える。取り違えていた場合（＝ `quantity` が倍率換算済みだった場合）この実装は
  使用率を**過大**に見積もる＝早めに `tight` に倒れる安全側に外れる。
- **実レスポンスは docs の例と表記が違った**: `product` は小文字 `"actions"`（docs の例は `"Actions"`）、
  `unitType` は `"Minutes"`（docs の例は `"minutes"`）、`date` は `"2026-07-01T00:00:00Z"`（docs の例は
  `"2023-08-01"`）。**docs の例をそのまま前提に実装していたら全件取りこぼして誤判定していた**ので、
  比較は全部大小無視にした（未確認の仮説で実装しない、という引き継ぎ doc の要求が実際に効いた）。
- **`Actions storage`（GigabyteHours）を分の枠と混ぜない**。含有枠が別建てなので、artifact が溢れて
  storage に課金が乗っただけで `exhausted` にすると、自発 dispatch が無関係な理由で恒久的に止まる。
  分の枯渇は分課金項目の `netAmount` と使用率で直接見る。
- **分課金項目が1件も無い月は `ok`（使用0）ではなく `unknown` にした**。「本当に使用0」と
  「`unitType` の表記が変わって全件落ちた」を区別できず、後者を `ok` と読むと*恒久的な*誤 `ok` になる。
  月初に一時的に `unknown` が出る不便より fail-open を嫌う。同じ理由で未知 SKU の分項目も `unknown`
  （倍率を推測しない）。

## 2026-07-25 net-fetch共通allowlistにFlickr写真CDNを追加

nikki-san で Flickr移行写真の `_o`/`_z` 実サンプルをnet-fetch経由で取得し、JPEG圧縮パラメータ
（Flickrの縮小版生成クオリティ）を調査する必要が生じた。取得先の `live.staticflickr.com`・`filedn.eu`
はどちらも不特定多数のユーザーの公開コンテンツを配信する汎用CDNで、ドメイン自体に個人性は無い
（取得する特定のURLが個人の写真を指すだけ）ため、機微ドメイン判定の対象外とし共通ベースに追加した。

判断根拠の整理: allowlistの共通/固有区分は「そのドメインが一般に機微データを扱うか」で決めるべきで、
「今回取得したい個々のコンテンツが機微か」で決めるべきではない（後者は実行モード＝集約/分散の判断軸）。
当初これを混同し、nikki-sanのローカルallowlistに追加しようとして手戻りになった。

副産物として、net-fetch.md の「共通ベースへの追加」手順が、consumer から出す outbox 提案（非同期・
collect cron待ち）と、`add_repo` を持つエージェントが ai-ops を直接編集する経路のどちらを使うべきか
明示していなかったため誤って前者を選んだ。手順に優先順位を明記する修正を別途 shared-file として本PRに
含めた。

さらにユーザーから、ドメインの機微性とは別に GitHub Actions の月枠逼迫がある指摘を受けた。枠残量その
ものを直接取得する手段は無い（billing API はPAT必須・アカウント単位・遅延あり）が、ユーザーの再指摘で
「間接判定は可能」と気付いた: このアカウントの consumer リポジトリは枠逼迫時にdeployをCloudflare側へ
手動退避する repo variable を運用しており（nikki-sanの`PAUSE_GH_DEPLOY`/`PAUSE_ADMIN_WORKER_DEPLOY`）、
変数の値を直接読めなくても、対象repoのpush起点deploy workflowの直近runがconclusion=skipped続きなら
「枠逼迫で退避中」と判定できる（`list_workflow_runs`で取得可能・追加の資格情報不要）。実際に nikki-san
の`deploy.yml`を確認したところ直近複数runが軒並みskippedで、現在まさに逼迫中と確認できた。同一
アカウント配下の他privateリポジトリもActions枠を共有するため、この判定は分散モードの可否判断に転用
できる。net-fetch.md に「間接判定をまず試み、それでも確信が持てなければユーザーに確認する」形で追記した
（判定できないリポジトリでは引き続きユーザー確認が必須）。quota-gateの自動化自体は今後の課題として残る。

## 2026-07-25 net-fetch 共通 allowlist に developers.cloudflare.com を追加

「枠が `tight` のとき GitHub Actions 側の deploy を自動で止められるか」を設計するのに、
**Cloudflare 側の切替設定（Pages の Build watch paths / Workers Builds の設定）が API で
変更できるか**の裏取りが要る。ここが可能なら両側を自動で反転でき、不可能なら
「GitHub 側だけ止める＝両方 off（どこにもデプロイされない）」を受け入れるかの判断になる——
設計の分岐点そのものなので、推測で決めない。

`developers.cloudflare.com` は公開ドキュメントで認証不要・機微でないため共通ベース
（集約モード＝ public な ai-ops 上での取得）に置ける。機微なら private リポジトリの
ローカル allowlist に置く判断になるが、これは該当しない。

## 2026-07-24 403 を「報告して終わり」にする穴を共通ブロック側で塞いだ

Actions storage の作業中に `docs.github.com` が 403 で弾かれ、共通ブロック「外部 URL アクセスの報告」に
従って「接続できなかった URL」として報告した — そこで止めて手元の知識で答えてしまい、net-fetch 手順に
入らなかった（ユーザーの指摘で発覚）。

構造的な原因は**アンチパターンの警告が手順の内側にあったこと**。`docs/net-fetch.md` の「よくある失敗」
冒頭はこの失敗をそのまま書いているが、オンデマンド層の doc は「net-fetch を使おう」と決めた後にしか
読まれない。＝**手順に入らない失敗を、手順に入った人しか読めない場所で防ごうとしていた**。

加えて常時ロード層の 2 節が隣接していて、403 に対して:

- 「外部 URL アクセスの報告」は具体的で即時に完了できる行動（報告する）を与える
- 「外部ネットワーク取得が要るとき」の発火条件は抽象的（「egress 制限で届かず、取得が作業に必要になったら」）

となっており、報告を済ませた時点で義務を果たした感覚になる。そこで常時ロード層の側を直した:
報告節に「報告は取得の代わりにならない・403/407 は net-fetch の発火トリガ」を明記し、net-fetch 節の
発火点を「403/407 で弾かれた瞬間」と具体化した。オンデマンド doc 側は既に正しいので触っていない。

## 2026-07-24 net-fetch SOP: 能力不足時は分散モードへ落とさず停止する（Codex #644/#406）

consumer 同期 PR（nikki-san#644 / private#406）に付いた Codex レビュー2件が、`shared/docs/net-fetch.md`
（ツール中立化 #74 で書いた版）の同じ欠陥を指摘: `add_repo` 等の集約実行能力を持たないエージェントに
「分散モードを既定にする／分散へ切り替える」と書いていた。これは**能力（ツールの有無）でモードを選ぶ**
ことになり、同 doc の原則「モードは可視性・機微性だけで選ぶ／モード切り替えを allowlist 回避に使わない」
（前提節・モード節の MUST NOT）と矛盾していた。具体的な害: 機微でない public 相当の取得でも、ホストが
共通 allowlist に無く `.github/net-allowlist.local.txt` にだけ有る場合、分散に落ちると手順 step 3 が
「許可済み」と扱って共通 allowlist へのユーザー判断を素通りし、public 相当の取得を private の Actions 枠・
非公開 `ci-logs` に落としてしまう。

修正: 集約が正しい（＝機微でない）のに集約を実行できないエージェントは、分散へ回避せず**停止して
ユーザーに集約実行（repo 追加か ai-ops への dispatch/読み取り）を依頼する**（MUST）に統一。分散で起動する
のは step 1 で取得内容が機微＝分散が正しいと判断したときだけ、と明記して doc 内の自己矛盾を解消した。
AGENTS_COMMON 側の net-fetch 節は元から「勝手に分散へ切り替えない」で正しく、修正不要。

追加（Codex private#407、別 sync #75 由来の別指摘）: step 4 で「git ref は既定ブランチを指す」が
**REST 経路だけ MUST**で、`gh`/MCP 経路は無キーワードの説明文だった。SOP 書式では無キーワード文は
「要求ではなく説明」と読まれるため、`gh`/MCP でエージェントが現在ブランチ／feature ブランチの ref を
渡してもルール上は許容され、レビュー済みでない `net-fetch.yml`・allowlist のコピーが走りうる。
修正: 「既定ブランチ ref を指す」を**全 dispatch 手段共通の MUST**（別ブランチ ref を渡すのは MUST NOT）
に格上げし、手段ごとの満たし方（REST=body の `ref`／`gh`=`--ref`／MCP=ref パラメータ）は MUST の下の
補足に整理した。同 PR にまとめた（同一 doc の連続した SOP 是正のため）。

## 2026-07-24 配布変更のダウンストリーム（consumer 同期 PR）確認ルールを AGENTS.md に追加

net-fetch 配布の一連で、**ai-ops 本体の PR には出ず consumer 同期 PR でだけ出る Codex 指摘**があった
（#68 では出ず nikki-san#636 でスクリプト注入 P1、private#401 で PEM・クエリの指摘）。ユーザーが3つの PR を
挙げてくれて初めて拾えた。これを取りこぼすと配布物の欠陥が全 consumer に残るため、shared/ を触るセッションが
下流を確認する運用を明文化した（当初検討した常駐ウォッチャー Routine は、`create_trigger` 経由の fresh セッションに
github connector が渡らず機能しないため、代替としてセッション主導の確認ルールにした）。

実態の確認（今回計測）:
- 同期 PR（head `ai-ops/sync-common`）は **MERGE_MODE=direct で作成から約2秒で自動マージ**される
  （nikki-san#639 / private#404 とも created と merged がほぼ同時刻）。
- Codex は**マージ後**の同期 PR を数分後にレビューしうる（#636/#401 はマージの1〜4分後にレビューが付いた）。
  一方 #639/#404 はレビューが付かなかった（Codex は best-effort・非決定的）。
- したがってルールは「open な同期 PR を待つ」ではなく「**マージ済み同期 PR の Codex レビュー・CI を数分後に見る**」。

ルール（`AGENTS.md`「配布変更のダウンストリーム確認」）:
- 配布変更 PR は自分の PR を購読し、マージ後に consumer の最新同期 PR（`consumers.txt` の各 repo）の Codex/CI を確認。
- consumer 確認には `add_repo`(read) が要る → エージェント起点で勝手に追加せず**ユーザー承諾を得てから**（AGENTS_COMMON 準拠）。
- 指摘は **ai-ops 正本で修正**（consumer PR は手編集しない）。同一ファイル配布なので1回の正本修正で全 consumer 分が直る。
- outbox 由来の取り込み PR は提案元セッションが居ないので、取り込み PR を扱うセッションが同手順で行う。

参考: #71 の配布（#639/#404）は今回チェック済みで Codex 指摘・CI 失敗とも無し（net-fetch の実修正は #71 本体で
Codex レビュー済みのため上流で vetted）。

## 2026-07-24 net-fetch 共通 allowlist に www.githubstatus.com を追加、hysteria の広すぎるエントリを削除

private リポジトリのセッションで GitHub の PR 作成 API が 500 を返し続けたとき、「GitHub 全体の障害か個別の
エラーか」を一次情報で判定しようと `https://www.githubstatus.com/api/v2/summary.json` を取りにいって 403 で
弾かれた。切り分け自体は他の手段（レスポンスヘッダの `Server: github.com` と `X-Github-Request-Id`、正しい
base での 500 と不正な base での 422 の対比）で確定できたが、status API が読めれば1回で済む話だった。障害の
切り分けは今後も繰り返し起きるので、認証不要・公開・非機微の status API を共通ベースに入れる。

あわせて末尾の `hysteria.network` / `*.hysteria.network` を削除した。この2行は symlink ドリフト障害
（root コピーが shared と別実体で、shared だけ直しても集約実行に効かなかった件）の切り分け中に「範囲が
狭すぎるのが原因では」と疑って足されたもので、真因が root の symlink 化で解消した今は不要。実際に必要なのは
`v2.hysteria.network` だけで、これは残っているので取得能力は落ちない。ファイル冒頭の「迷ったら足さない。
実際に必要になったドメインだけを、必要な粒度で足す」に合わせた。

なお `www.githubstatus.com` は `www.` 付きの完全一致1行だけにした（`*.githubstatus.com` は足していない）。
実際に叩くのが www ホストのみで、同じ粒度の原則に従ったため。

## 2026-07-24 net-fetch: SOP を非 Claude エージェント向けにツール中立化

ユーザーから「net-fetch の GitHub Actions は Claude Code 以外のエージェントで問題を起こさないか」と問われ、評価した。

評価の結論:

- **インフラ本体は問題なし**。workflow / composite action / net-fetch.sh は完全にエージェント非依存で、
  allowlist・SSRF ガード・secret スキャン/伏字・クリーンルームは全部 GitHub Actions 側（サーバ側）で enforce する。
  誰が `workflow_dispatch` しても同じ保護。配布も `apply-shared.mjs` が SKILL を `.codex/.openhands/.gemini/.agents/
  .qwen/.cline` へミラーするので全エージェントが見える。常時注入ではなく on-demand skill 層なので、発火しなければ不活性で
  他エージェントの通常タスクを壊さない。
- **ギャップは SOP の文面**にあった。`shared/docs/net-fetch.md` が Claude Code on the web 固有のツール語彙前提で、
  他エージェント（Codex/Gemini CLI/OpenHands/Qwen/Cline）では次が噛み合わない:
  - step 2/3 の `add_repo`（別リポジトリのセッション追加）は Claude-web 固有ツール。集約モードは「public な ai-ops に
    add_repo して dispatch」する構成なので、これを持たない他エージェントは**既定の集約パスの最初で詰まる**。
  - step 4「workflow_dispatch で起動」・step 5「ci-logs ブランチを読む」は具体手段を書かず特定ツール前提だった。

対処（`shared/docs/net-fetch.md` のみ改訂。SKILL ラッパーと AGENTS_COMMON の常時ブロックは中立・最小なので不変）:

- **能力ベースの前提節を追加**: 「dispatch できる」「ci-logs を読める」「（集約なら）ai-ops を参照できる」を*能力*として列挙し、
  何で満たすか（MCP/`gh`/REST/`git fetch`）はランタイム依存と明記。**満たせなければ停止してユーザーに依頼**（MUST）。
- **モードの適用範囲を明記**: 集約は `add_repo` 等（別リポジトリのセッション追加）が前提。その手段を持たないエージェントは
  **分散モード（作業中リポジトリで完結）を既定**にする。ただし「可視性・機微性でモードを選ぶ」MUST は保ち、能力制約で集約が
  *使えない*ことは、allowlist 回避目的の**モード切替（MUST NOT）とは別**として carve-out した。
- step 4/5 をツール中立化（`gh workflow run` / REST dispatch / `git fetch origin ci-logs` を例示、手段は不問）。

なぜインフラを変えずに doc だけ直したか: セキュリティ保証はサーバ側にあり、エージェント差はワークフローの起動主体だけ。
壊れるのではなく「Claude-web 固有名で書かれた手順が他エージェントで実行不能」というグレースフル劣化だったので、正本 doc の
表現をツール中立にすれば全エージェントで使える（同一ファイルを配る性質上、1回の正本修正で全 consumer 分が直る）。

配布影響あり（`shared/**`）なので、マージ後に consumer 同期 PR（head `ai-ops/sync-common`）の Codex レビュー・CI を見届ける。

## 2026-07-24 net-fetch: 共通 allowlist を root symlink 化（ドリフト解消）＋伏字境界を拒否と一致

#70 マージ後、ユーザーが `shared/.github/net-allowlist.txt` に `hysteria.network` / `*.hysteria.network` を
直接足したが、ai-ops 自身の集約実行が読む **root コピー `.github/net-allowlist.txt` が更新されず**、集約モードで
`hysteria.network` が拒否され続けた（Codex #70 が指摘。「shared だけ更新、root は未反映」）。dual placement
（branch-cleanup と同じ byte-identical copy 方式）を allowlist に使うと、手編集で片側だけ直すドリフトが起きる。

対処:

- **root `.github/net-allowlist.txt` を `../shared/.github/net-allowlist.txt` への symlink に変更**。ai-ops の
  集約実行は symlink 越しに shared の正本を読むので、**手編集は shared 一箇所だけ**でよくなり構造的にドリフトしない
  （`docs/*.md -> ../shared/docs/*.md` と同じ作法。workflow/action は Actions が実ファイルを要求するので copy の
  ままだが、allowlist は script が読むデータなので symlink で問題ない）。consumer には従来どおり sync が実ファイルを配る。
- **伏字境界を拒否パターンと一致**（Codex #70 P2）: `SECRET_QUERY_KEYS` の拒否は `key=` を位置を問わず一致させるのに、
  `redact_secrets` は `?`/`&` 直後の `key=` しか伏字にしていなかった。`https://example.com/path;access_token=secret` は
  拒否されるが `SAFE_URL` に生値が残り公開 ci-logs に漏れうる。伏字の `[?&]` アンカーを外し、値終端を
  `[^[:space:]&#;]*` にして拒否と同じ広さにした。

collector 例外の明文化（ルール整合）: 「新規ワークフローは collector に登録する」は codified rule（`ci-logs.md` 手順4・
nikki-san の DEPLOY_LOGGING_DESIGN.md チェックリスト）。net-fetch を登録しない判断を**ルール未修正のまま放置していた
＝サイレント違反**だったので、`shared/docs/ci-logs.md` に「リクエスト単位で毎 run inline publish するワークフロー
（net-fetch）は collector 登録の対象外」を根拠付きで明記した（黙って回避せず、逸脱はルール側に書く）。

なぜ private に collector が無いか: collector は**リポジトリ固有で配布物ではない**うえ、private は nikki-san とは
**別のログ設計**を採る。private の `deploy-workers.yml` は各 deploy ログを `deploy-logs/<worker>.log` に書いて
artifact 化し、`commit-logs` ジョブが `cloudflare_workers/deploy-logs/` に**コミットして**残す方式で、nikki-san の
`ci-logs` ブランチ＋`publish-ci-logs`＋`collect-deploy-run-logs.yml` の2層モデルを使っていない。よって private に
collector が無いのは抜けではなく設計差（Codex が collector 登録を nikki-san#636 でだけ挙げたのも、collector が
あるのが nikki-san だけだから）。net-fetch 配布で private にも `ci-logs` 系が入り、native の deploy-logs 方式と併存する。

学び: 「片方を直したらもう片方も直す」値（同一 allowlist の2コピー）は、AGENTS_COMMON「コードの重複に気づいたら
共通部品化」の典型。ai-ops 内で同一内容を複数パスに置くなら symlink にして正本を1つに保つ（ops-sync-design の作法）。

## 2026-07-24 net-fetch: REST dispatch 例に必須 `ref` を明記（#74 follow-up）

#74（SOP ツール中立化）が REST dispatch 経路を新たに手順に載せたが、GitHub の workflow-dispatch REST
エンドポイント（`POST .../actions/workflows/{file}/dispatches`）は body に `ref` が**必須**なのに、step 4 は
`url`/`request_id` しか渡すよう書いておらず、**REST 経由のエージェントは 422 で run が作られず ci-logs スライスが
出ない**。マージ後の Codex レビュー（#74 の P2）が指摘。

#74 は既にマージ済みなので、マージ済みブランチに積まず**最新 main から貼り直して新規 PR** で follow-up
（マージ済み PR は再利用しない規約）。

対処: step 4 に「workflow を回す git ref は対象リポジトリの既定ブランチ（通常 `main`）」を明記し、
「REST を使うときは body に `ref` を必ず含める（無いと 422）」を追記。`gh workflow run` は未指定なら既定ブランチを
使うので省略可、MCP dispatch ツールは ref パラメータに既定ブランチを渡す、という手段差も添えた。

学び: ツール中立化で特定経路（REST）を手順に載せるなら、その経路の**必須パラメータを漏れなく**書く。
「どれでもよい」と選択肢を増やすときは、各選択肢が単独で完結する粒度まで書かないと、一番不便な経路
（生 REST）を選んだエージェントだけ静かに詰まる。

追記（同 PR #75 の Codex 2巡目 P2）: 最初の追記は `ref` を「必ず含める」と書いたが、sop-format.md では手順の
必須要求は RFC 2119 大文字キーワードで示し、キーワードの無い文は説明として読まれる規約。省略すると 422 で
壊れる制約なので `含める（MUST）` に改めた。**「必ず／要」等の和文強調は SOP では規範として効かない**——
壊れる制約は MUST を付ける（この doc 群の他制約と同じ作法）。

## 2026-07-24 README の下流確認 scope を列挙せず AGENTS.md 参照に一本化（Codex #72）

#72 で README に足した下流確認ポインタが scope を `shared/**`・`AGENTS_COMMON.md` と**列挙**していたため、
AGENTS.md 側で対象を `sync-deletions.txt` 等に広げた後、README だけ狭いままドリフトした（Codex 指摘）。
scope を2箇所に書くと片方だけ直してドリフトする典型。README からは**列挙を外し**「配布に影響する変更を…／
対象・手順とも正本は AGENTS.md」に変えて single-source にした（`AGENTS_COMMON`「同じ事実の正本は1つに保ち
他からリンク」）。#72 マージ後の追随なので follow-up PR。

## 2026-07-24 SOP 書式規約に「ツール中立」節を追加（#644/#406/#407 の再発防止）

net-fetch SOP の2件の Codex 指摘（#406=モード選択をツール能力に紐づけた／#407=`MUST` を REST 経路だけに
付けた）は、どちらも「配布手順は複数エージェント（Claude/Codex/Gemini/OpenHands）が実行する」前提を書き手が
外したことが根因だった。個別修正（PR #76）だけだと同じ書き手ミスが別 doc で再発するので、規約側（正本
`shared/docs/sop-format.md`）に明文化した。

3点を MUST/MUST NOT 化: (1) 要求するのは「能力」であって特定ツールではない（*何で*満たすかは補足に留める）、
(2) 判断・分岐をツールの有無に紐づけない＝能力不足は別振る舞いへ切り替えず停止して依頼、(3) 同じ要求は全ツール
経路に効くよう書く＝キーワードを一部経路だけに付けない（無キーワードは「説明」と読まれる規約と接続）。
#406/#407 を実例として各項に添え、抽象論で終わらせない。

配置判断: 2軸で共通×オンデマンド。sop-format は SOP 作成/改訂時に skill で自動発火する既存の書式規約 doc で、
RFC 2119 キーワード規律も既にあり (3) が自然に接続するため、ここに節を足すのが導線・整合の両面で最適。
AGENTS_COMMON（常時ロード層）には足さない（全タスクのコストに乗せない）。
