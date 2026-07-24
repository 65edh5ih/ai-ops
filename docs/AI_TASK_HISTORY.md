# ai-ops 作業履歴

ai-ops での作業の「**なぜ**」の記録。書き方・アーカイブは共通規約 [`task-history.md`](task-history.md) に従う
（consumer に影響する変更・内部だけの変更の区別なくここ1箇所 → [`AGENTS.md`](../AGENTS.md)「履歴ファイル」節）。

---

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

## 2026-07-23 net-fetch: 共通 allowlist に実ドメイン追加＋「allowlist 欠落時にモードを勝手に切り替えない」ルール

private リポジトリでの net-fetch テスト（`https://v2.hysteria.network/docs/Changelog/` の取得）で2つ判明:

1. **共通 allowlist が効かない**: ユーザーは `v2.hysteria.network` を「共通許可リストに追加した」認識だったが、
   ai-ops main の正本 `shared/.github/net-allowlist.txt` には入っていなかった（配布コピーやローカルを触った
   か、未マージだった可能性）。共通リストの唯一の正本は ai-ops の `shared/.github/net-allowlist.txt` で、
   sync で各 consumer の `.github/net-allowlist.txt` に配布されて初めて効く。正本に `v2.hysteria.network` を
   追加（＋ai-ops 自身のバイト一致コピー）。public な docs ドメインなので共通ベース（public 経路）に置いてよい。

2. **allowlist 欠落を分散モードで回避しようとした**: private の agent が「集約は outbox→同期→マージで非同期
   だから、今答えるために分散モード（このリポジトリ自身で実行）に切り替える」と判断しかけた。これはモード
   切り替えを allowlist 追加プロセスの回避手段に使うもので、「何を許すかはユーザーが決める」統制を崩す。
   ユーザーが停止させた。

対処（ルール）: モードは**可視性・機微性（将来は枠残量）だけ**で選ぶものと明記し、allowlist に無いドメインを
取得しようとしたら **停止してユーザーに手動追加を依頼する**（MUST）／**勝手に分散モードへ切り替えない・自分で
allowlist に足して続行しない**（MUST NOT）を、常時層 `AGENTS_COMMON.md` と手順 `shared/docs/net-fetch.md`
（モード節＋手順3）の両方に入れた。依頼にはどのファイルに何を足すかを明示する。

学び: net-fetch のモード選択（集約/分散）は「どこで実行し結果をどの可視性に置くか」の軸であって、allowlist の
穴を埋める手段ではない。allowlist 追加はユーザー統制下の非同期手続きで、即時性より統制を優先する。

## 2026-07-23 net-fetch: consumer 同期 PR の Codex 追加指摘（注入・PEM・クエリ）を正本で修正

nikki-san#636 / private#401（net-fetch を配布した同期 PR）への Codex レビューが、ai-ops#68 には無かった
**追加の指摘**を出していた。配布ファイルなので正本 ai-ops で直し、sync で全 consumer へ再配布する。

- **スクリプト注入（nikki-san P1・重大）**: workflow の Summarize `run:` に `${{ inputs.request_id }}` を生で埋めており、
  GitHub が bash 実行前に展開するため `request_id=$(...)` で任意コマンド実行できた（fetch が reject しても
  `always()` の要約ステップで走る）。#70 の初回修正で `url` の生埋め込みは消したが **`request_id` を残していた**。
  対処: 動的値をすべて `env:` 経由で渡し、`$VAR` を `printf` する（env の値は再評価されない）。URL は伏字済み
  meta.txt から拾う。
- **PEM ブロック未伏字（private P2）**: `-----BEGIN … PRIVATE KEY-----` パターンは BEGIN 行しか一致せず、行単位の
  sed 伏字だと base64 本文・END が response.txt に残っていた（集約モードで公開 ci-logs に落ちる）。
  対処: `redact_file()` を追加し、awk で BEGIN〜END を丸ごと `[REDACTED-PRIVATE-KEY]` に置換してから token 類を sed。
- **クエリ/フラグメントで allowlist 誤判定（private P2）**: host 抽出がパスの無い `https://example.com?x=1` /
  `#frag` で `?`/`#` を落とさず、`example.com?x=1` を allowlist と突き合わせて**許可済みでも拒否**していた。
  対処: host 抽出で `?` と `#` も除去。
- **collector 登録（nikki-san P2）**: 「新規 workflow はフル生ログ collector の一覧へ失敗時ゲートで登録」は
  **リポジトリ固有**（collector `collect-deploy-run-logs.yml` と設計 doc は nikki-san ローカル・配布対象外）。
  正本では直せないので nikki-san 側のローカル変更で対応する（別 PR）。

- **userinfo 資格情報の漏洩（#70 への再レビュー P1）**: `SAFE_URL` は token パターンとクエリ値しか伏字にせず、
  `https://user:pass@host/` の `user:pass@` を残していた。userinfo チェックで fetch は reject するが `emit` は
  `SAFE_URL` を `meta.txt` に書く→集約モードで公開 ci-logs に資格情報が残る。対処: `redact_secrets` に
  `s|(://)[^/?#@]*@|\1[REDACTED-USERINFO]@|` を追加（パス/クエリ中の `@` は `/?#` 境界で誤爆しない）。

学び: 配布物への指摘は「同一ファイルを持つ全 consumer 分」を1回で正本修正すれば足りるが、consumer ごとに
Codex が見る文脈（各 repo の AGENTS.md・collector 有無）が違い、**consumer PR にしか出ない指摘**もある
（今回の注入・PEM・クエリは #68 に出ず #636/#401 で出た）。配布した net-fetch のレビューは consumer 側 PR も
必ず確認する。workflow の `run:` に `${{ inputs.* }}` を生で埋めない（env 経由）ことは全 workflow 共通の鉄則。

## 2026-07-23 net-fetch: Codex レビュー指摘（P1 secret 漏洩 / P2 パストラバーサル）を修正

ai-ops#68（および同一ファイルを配布した nikki-san#636・private#401）への Codex レビュー2件を正本で修正した
（配布ファイルなので consumer PR を手編集せず ai-ops で直す）。

- **P1（secret 漏洩）**: secret を含む URL を拒否しても `emit()` が生 URL を `meta.txt` に書き、`net-fetch.yml` は
  rejected でも `net-fetch-out` を publish するため、集約モードだと**公開 `ci-logs` に secret が残る**。
  対処: `redact_secrets()` を追加し、出力に載せる URL は secret パターン＋secret 臭いクエリ値を伏字にした
  `SAFE_URL` を使う（`meta.txt` の `url=`）。workflow の Summarize も生入力ではなく伏字済み `meta.txt` から
  URL を拾う（要約は public な run ログにも出るため）。
- **P2（パストラバーサル）**: publish の `dest` に検証前の生 `request_id` を使っていたため、`../branch-cleanup/latest`
  や `..` で net-fetch/<id> スライス外へ publish できた（スクリプトが reject しても publish は `if: always()`）。
  対処: スクリプトが `request_id` を検証（`^[A-Za-z0-9._-]+$` かつ `..` を含まない）し、通らない id は
  ユーザー制御でない `net-fetch/_invalid-<ts>-<pid>` へ退避した `dest` を GITHUB_OUTPUT に出す。workflow は
  生入力ではなく `steps.fetch.outputs.dest` を publish の dest に使う。空 dest のときは publish しないガードも追加
  （空を publish-ci-logs に渡すと clone を丸ごと消しかねないため）。

学び: net-fetch の結果は集約モードで public な `ci-logs`／run ログに出るので、**出力に載る文字列（URL・dest・
要約）はすべて「拒否した入力でも安全か」を基準に組む**。拒否は「弾いて緑で publish」なので、拒否した生入力が
出力経路に載らないことまで含めて設計する。

## 2026-07-23 net-fetch: エージェントの代理インターネット取得リレーを共通基盤として追加

Claude Code の許可ドメイン egress が機能しない環境向けに、GitHub Actions ランナー（フルのネット接続を持つ）を
中継して**許可ドメインだけ**を取得するリレーを追加した。エージェントは egress 制限下でも GitHub には到達できる
ため、GitHub 自体を中継所にする構図。正本は `shared/`（全 consumer へ配布）、ai-ops 自身にもバイト一致コピー
（`branch-cleanup` と同じ dual placement）。

判断の経緯（コードに残らない前提・制約）:

- **集約 vs 分散**: 実行を public な ai-ops 上で回せば GitHub Actions 分が無料（既存の「ai-ops を public に
  している理由」と同じ）。ただし結果は ai-ops の `ci-logs`＝世界公開に落ちる。そこで両モードを同一 workflow
  で持ち、**どのリポジトリで起動するかだけがモードの違い**にした。現状の既定は集約（枠逼迫のため）。
- **allowlist 2層（共通配布 ∪ リポジトリ固有）**: 共通ベース `.github/net-allowlist.txt`（配布）に加え、
  各リポジトリの `.github/net-allowlist.local.txt`（配布対象外・repo 所有）を union。**機微を取得しうる
  ドメインは private リポジトリのローカルにだけ書く**運用。集約モードの判定は共通ベースのみを見るので、
  機微ドメインは構造的に public 経路を通れない（配置がルールを強制する。人の規律に依存しない）。
  `.local.txt` を配布しない（shared に置かない）のは、置くと manifest 管理下になり同期で上書きされ
  「repo 所有」でなくなるため。
- **secret を fetch に含めさせない縛り**: 取得ジョブに secret を一切渡さない（クリーンルーム）を第一の
  構造的縛りにし、request の URL/クエリの secret パターン拒否・response の secret 伏字を二層目に置いた。
  publish（ci-logs へ push）に使う github.token は取得ステップの env に載せない。
- **consumer 側に dispatch トークンを置かない**: エージェントは自前の GitHub 資格情報で workflow_dispatch
  する。過去に上りの即時化で置いた `OPS_DISPATCH_TOKEN`（consumer→ai-ops 書き込み）を「ルール正本への
  増幅経路」として撤去した経緯（→ ops-sync-design.md）と同じ理由で、consumer に常設トークンを増やさない。
- **SSRF ガード**: allowlist と無関係に、https 以外・URL 内資格情報・IP リテラル・localhost・クラウド
  メタデータ（169.254.169.254 等）・リダイレクト追従を常に禁止。allowlist はドメイン前提なので通常は
  一致しないが、明示的に弾いて意図を固定した。
- **枠連動（quota-gate）は今回作らない**が、あとで共通基盤として差し込めるよう継ぎ目を用意した。集約/分散の
  両実行経路は既に存在するので、将来足すのは「枠残量でどちらを選ぶか」の判定層だけ（この workflow・SOP は
  変更不要）。枠残量は billing API 経由（PAT 必須・アカウント単位・遅延あり）でしか取れないことも確認済み。

学び: 新規 shared workflow なので docs/ci-logs.md に従い publish-ci-logs を組み込む必要があるが、net-fetch は
「取得結果そのものを per-request スライスへ publish する」ことが inline publish を兼ねる（別途 logs/ci/scripts を
足さず、結果 publish で要件を満たした）。

## 2026-07-23 archive-task-history に統合時の重複排除（dedup）を追加

- **なぜ**: PR #58（自動アーカイブ）に Codex P2「重複した履歴エントリ」。`archive-task-history.mjs` は
  inbox フラグメントを本体（`AI_TASK_HISTORY.md`）と突き合わせずに無条件連結していたため、本体に既にある
  エントリと同一内容のフラグメントを置くと、統合で本体に区別できない同一レコードが2つ並ぶ。実際 `2026-07-20
  history-inbox…プレースホルダ化` の未消化フラグメントが本体の同エントリと byte 一致（trim・1402B）で残って
  いて、次バッチで二重取り込みされる生きた状態だった。
- **修正（恒久）**: 統合フェーズで、本体にある dated エントリの**本文全体（trim）**を set 化し、同一本文の
  フラグメントは取り込まない。ただしフラグメントは消費（削除）して掃除する（本体に既にあり情報は失われない）。
  inbox 内どうしの重複も同じ set で1つに畳む。全エントリが重複のファイルも consume 対象なので、次バッチが
  自動で掃除する（自己修復）。
- **判定を「本文全体一致」にした理由（コードに無い制約）**: 見出しだけの一致で消すと、同日別タイトルの正当な
  エントリ（例: 2026-07-20 が本体に2件・別内容で並存）を誤って落とす。実害のある重複は byte 一致なので本文
  全体一致だけを重複とみなす。
- **スコープの限界**: 重複判定は**本体のみ**が対象で、アーカイブ済みエントリとの突き合わせはしない（Codex
  指摘の本体二重化が対象。年ファイル全ロードは重いので見送り）。
- **応急**: 上記 07-20 重複フラグメントは同 PR で削除済み（恒久修正でも次バッチで掃除されるが、それまでの
  read 時二重を消すため即削除）。テスト基盤が無いため一時スクリプトで本体重複／非重複／inbox 内重複／
  重複のみの4ケースを検証（コミットしない）。

## 2026-07-23 branch-cleanup workflow に publish-ci-logs を後付け（Codex P2 / #63 の抜け）

#63 で追加した branch-cleanup workflow が、共通必須ルール「新規 `.github/workflows/` には publish-ci-logs で
CI ログ出力を組み込む」（`docs/ci-logs.md`）を満たしておらず、private の sync 生成 PR #397 で Codex P2 が指摘。
初版は stdout と `$GITHUB_STEP_SUMMARY` にしか出しておらず、削除結果・失敗が ci-logs ブランチに残らなかった。

対処: 正本 `shared/.github/workflows/branch-cleanup.yml`（＋ai-ops 自身のバイト一致コピー）に、docs/ci-logs.md の
手順どおり (1) `permissions: contents: write`（既存）、(2) 本体ログを `logs/ci/scripts/branch-cleanup.log` へ tee、
(3) 末尾に「Stage CI log snapshot」＋「Publish logs to ci-logs branch」を `if: always()` で追加。inline publish
（常時）層のみ。フル生ログ collector への登録は**リポジトリ固有**なので shared には入れない（collector を持つ repo
だけ、その workflows 一覧に失敗時ゲートで足す＝各 repo 側の follow-up）。

学び: 新規 workflow を書くときは docs/ci-logs.md を先に読む（#63 で読み飛ばした）。shared 配布の workflow は
全 consumer に同じ抜けが伝播するので、共通必須ルールの充足はマージ前に確認する。

## 2026-07-23 stale ブランチ手動削除 workflow（branch-cleanup）を shared 配布で新設

private の Cloudflare Workers Builds 接続で Production branch 一覧に main が出ない件の根因が、
エージェント生成の stale ブランチ大量残留（private 264本・codex/claude 主体）だったため、手動トリガの
一括削除 workflow を追加。3リポジトリ（private / nikki-san / ai-ops）に同一で入れたいので shared 配布にした。

判断・ハマりどころ:
- GitHub の "Automatically delete head branches" は**マージされた PR の head しか消さない**。close/PR無し/
  設定前のブランチは残る（＝ON でも溜まる。ユーザーが「ON なのに同症状」と指摘。仕様どおり）。だから
  掃除 workflow が要る。
- **workflow ファイルの配布には token 権限の壁**: sync は `OPS_SYNC_TOKEN`（PAT）で consumer に push するが、
  GitHub は `.github/workflows/` 配下を `workflow` 権限の無い PAT で push させない。従来の shared 配布物は
  composite action（`.github/actions/`）止まりで workflow ファイルは初。**OPS_SYNC_TOKEN に Workflows 書き込み
  権限の付与が必要**（無いと sync PR の push が consumer で失敗する）。Codex P1 の指摘どおり README・
  ops-sync-design.md（Secret 表＋設計注記）・sync.yml コメントの token 権限記載を Workflows:RW 込みに更新。
  設計 doc は元々この権限を「blast radius を広げる」と避ける論調だったが、ユーザー判断（A: shared 配布維持）で
  付与する方針とし、対象は token が既に Contents:RW を持つ同じ repo 群に限られる点を注記に明記した。
- ai-ops は sync の consumer ではない（consumers.txt = nikki-san, private のみ）ため、shared の正本に加えて
  ai-ops 自身の `.github/workflows/` にも**バイト一致コピー**を置く（両方を同時に直す）。
- 安全設計: 手動のみ（workflow_dispatch）・**既定 dry-run**・既定ブランチ/keep 一覧/オープン PR head を常に
  除外・prefixes 一致 かつ age_days（既定7）より古いものだけ対象。年齢は git committerdate で判定
  （squash マージだと ancestry でマージ済み判定できないため、prefix＋年齢＋オープン PR 除外で安全側に倒す）。
- keep 既定に nikki-san 固有の hugo-bin/deploy-logs も入れて全 consumer で1ファイルを使い回せるようにした
  （存在しない repo では無害）。

## 2026-07-23 ci-logs.md の失敗ゲート要件を RFC 2119 キーワード（MUST）化

- **なぜ**: #59 で `shared/docs/ci-logs.md` に足した「フル生ログ collector は失敗時のみ回収／新規 collector も
  同ゲート必須」を、配布先 private#392（sync 自動 PR）で Codex が P2 指摘。SOP 書式正本
  `shared/docs/sop-format.md` は「要求の強さは RFC 2119 キーワードで明示」「**キーワード無しの文は説明であって
  要求ではない前提で読まれる**」と定めるのに、当該要件が `必ず` としか書かれておらず MUST キーワードを欠いた
  ため、SOP に従うエージェントが「説明」と解釈して失敗ゲートを付け損ね、#59 が防ごうとしたコスト回帰を
  再発させうる、という指摘。正当なので正本を修正。
- **設計判断**: 該当要件を MUST 化（`collector は失敗時のみ回収する（MUST）`／`新規 collector も同ゲートを
  付ける（MUST）`）。あわせて条件式の略記禁止を `MUST NOT: == 'failure' || 'timed_out' と略す` として
  破ったら壊れる制約であることを明示（略記は GitHub Actions 式で常時真になりゲート無効化＝#59 レビューの P2）。
  修正は正本 `shared/docs/ci-logs.md` の1点のみ。private の `docs/ci-logs.md` は配布物なので手で直さず、
  sync が再配布して波及させる（private#392 のコメントにもその旨を返信）。
- **引き継ぎ**: #59 がマージ済みのため、指定ブランチ `claude/log-collection-error-only-hn3vmo` を最新 main から
  切り直して follow-up を積んだ（新規 PR）。

## 2026-07-23 dedup 挙動を共通ルール task-history.md にも反映（#60 follow-up）

- **なぜ**: #60（consolidate の dedup 追加）マージ後、Codex P2 が正本ルール `shared/docs/task-history.md` を
  指摘。統合の説明が「全フラグメントを本体へ取り込んでから削除」のままで、dedup パス（本体に既にある同一
  本文は取り込まず削除して掃除）と食い違い、重複のみの掃除 PR では正本手順が実挙動の逆を書いている状態だった。
- **対応**: 「統合とアーカイブ」節の consolidate 説明に dedup 例外を1文追記（見出しだけの一致では消さない、も明記）。
  #60 は既にマージ済みでブランチも削除されていたため、規約どおり最新 main から branch を切り直して cherry-pick
  し、別 PR として出した（マージ済み PR には積まない）。
- ops-sync-design.md・README は #60 で反映済み。3つ目の同期先が task-history.md（配布される正本ルール）。

## 2026-07-23 ai-ops を public 化（GitHub Actions 分数の枯渇対策）

ユーザー相談「Actions の月枠が切れそう。履歴アーカイブやリポジトリ間同期をやっている ai-ops を public に
しようと思うが注意点は？」を受けて public 化した。

- **なぜ public 化か**: 月内の Actions 残枠が20分未満まで枯渇し、ai-ops 自身の運用 workflow
  （sync / archive-task-history / collect-outbox）が枠切れで止まりかけていた。consumer（nikki-san / private）は
  既に Cloudflare Workers デプロイへ移行済みで、deploy が主犯ではない。**public repo は GitHub-hosted runner の
  Actions が無料**（アカウント枠を消費しない）ため、ai-ops 自身の workflow を枠から外すのが目的。
  consumer は private のままなので、そちらの Actions 分数は救われない（切り分けて認識する）。
- **public 化前の棚卸し（実施済み・クリア）**: 全 git 履歴の diff を secret パターンで走査 → 混入なし。
  インフラ機密（IP 帯・pfSense・sing-box 等）は private repo 本体にあり ai-ops にはミラーされていない。
  過去に private 宛だった `tasks/` ファイルの中身も運用手順のみ。残る露出は「`65edh5ih/private` という
  非公開 repo の存在」と運用メタ（PR 番号・workflow 名・構成メモ）のみで、これは許容と判断した。
- **入れたガード**: ①`main` のブランチ保護（無料アカウントでは **public でのみ enforced**。private 中は
  "Not enforced" 表示が正常で、public 化の瞬間に自動で効く）。承認必須は **0** にする（archive/collect が
  `gh pr merge` で自分の PR を PAT 自動マージするため、1以上にすると自動化が止まる）。②Settings → Actions →
  General の fork PR を **Require approval for all external contributors**（UI 文言が outside collaborators から
  改称された同一設定）。
- **なぜガードが要る/効く**: 唯一の機微は `OPS_SYNC_TOKEN`（全 consumer への Contents:RW/PR:RW を持つ合鍵）。
  Actions secret なので**可視性変更では露出しない**。かつ ai-ops の workflow はどれも `pull_request` で
  起動しないため fork PR からトークンを窃取する経路が構造的に無い（fork 承認制は二重の保険）。
- **PR #63 との関係**: stale ブランチ削除 workflow の shared 配布は `OPS_SYNC_TOKEN` に Workflows:write を
  要求する（設計が意図的に避けていた格上げ）。ただし PAT は既に Contents:RW を持つ＝既にクラウンジュエルで、
  増分は categorical でなく incremental。public 化は PAT の漏洩確率を上げない（上記の理由）ため、docs 更新
  （README・ops-design のトークン表）＋スコープ付与を条件に許容可、と整理した。
- 恒久的な運用前提（ai-ops=public / consumer=private の可視性モデルと帰結）は `shared/docs/ops-sync-design.md`
  「前提・限界」に現在形で記載した。

## 2026-07-23 CI ログ「失敗時のみフル収集」を正本 ci-logs.md に昇格（今後の実装へ引き継ぎ）

- **なぜ**: nikki-san #627 が `collect-deploy-run-logs.yml`（`workflow_run` のフル生ログ collector）を
  `conclusion == 'failure' || conclusion == 'timed_out'` でゲートし「失敗時のみ回収」に変えたが、この設計原則は
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
