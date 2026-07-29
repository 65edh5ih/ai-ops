# net-fetch: エージェントの代理インターネット取得（GitHub Actions リレー）

egress 制限下のエージェントが、GitHub Actions ランナー（フルのネット接続を持つ）を中継して
**許可ドメインだけ**を取得するための手順。secret を一切ジョブに渡さないクリーンルームで実行し、
allowlist・SSRF ガード・secret スキャンを workflow 側で enforce する。

## いつ使うか（トリガ）

- セッションの egress 制限で目的の URL に直接到達できず（403/407 等）、その取得が作業に必要なとき。
- 対象は「**認証不要で公開取得してよいリソース**」に限る（API キーや Cookie が要る取得はこのリレーの対象外
  ——クリーンルームは secret を持てない）。
- パッケージ取得（npm/PyPI 等）・git/GitHub 操作・設定済み MCP 経由の通信には使わない（元から通る）。

## 前提・パラメータ

- **取得先ドメインが allowlist にあること**。allowlist は2層の union:
  - 共通ベース: `.github/net-allowlist.txt`（ops-sync が全リポジトリへ配布。**public な ops-runner にも配られ、
    集約モードの判定に使われる**ため、機微を取得しうるドメインは**書かない**）。
  - リポジトリ固有: `.github/net-allowlist.local.txt`（各リポジトリが自分で持つ・配布対象外・任意）。
    **機微を取得しうるドメインはここ（private リポジトリのローカル）にだけ書く**。
  - 記法: 1行1ホスト。完全一致か `*.example.com`（サブドメインのみ・素の `example.com` には不一致）。
- **`<request_id>`**: `[A-Za-z0-9._-]+`。結果スライスのパスになる。取得ごとに一意にする（衝突回避）。
- **結果ブランチ `net-fetch-results`**（実行したリポジトリ内）。スライスは `net-fetch/<request_id>/`。
  **このブランチは揮発する**——書き込みのたびに orphan 1コミットへ書き換えられ、**3日（TTL）を過ぎた
  スライスは失効して消える**。失効の判定が走るのは「次の書き込み」と「日次の掃除ジョブ（sweep）」で、
  sweep は **public リポジトリでだけ**動く（private では Actions 枠を使わないため skip。理由は
  `net-fetch.yml` の `schedule:` のコメント）。よって実際の最大保持はモードで違う:
  - **集約モード（public な ops-runner）**: TTL＋最大1日（取得が続いている間は TTL ちょうどで消える）。
  - **分散モード（private リポジトリ）**: 失効は次の取得時にしか走らないので、**次に net-fetch を
    使うまで**最後のスライスが残る（上限なし）。非公開なので世界公開にはならないが、
    「3日で消える」と当てにしないこと。消したいときは結果ブランチを手で削除する
    （`git push origin --delete net-fetch-results`）。

  取得結果は
  「読んだら用済みの一次データ」なので、
  恒久ログの `ci-logs` には publish しない（public リポジトリでは削除しても git 履歴に永久に残るため）。
  よって **dispatch したら間を置かずに読むこと**（MUST）。古い取得を後から掘り返す用途には使えない。

  **上の TTL が縛るのは結果ブランチだけ**（重要）。同じ本文は「Echo result to job log」ステップで
  **ジョブログにも出る**（既定 256 KiB まで）ので、取得内容には寿命が2つある:
  - **結果ブランチのスライス**: 上記の TTL（git ブランチなので、リポジトリ設定の
    Artifact and log retention の対象**外**。書き換えられるまで残る）。
  - **ジョブログの写し**: リポジトリ設定 **Artifact and log retention**（既定 90 日・public は最大 90 日、
    private は最大 400 日）に従う。TTL では消えない。
    設定: `https://github.com/<owner>/<repo>/settings/actions`（Settings → Actions → General →
    Artifact and log retention）。

  つまり **public な集約モードでは、取得内容が TTL の3日を過ぎてもジョブログとして最大 90 日
  世界公開され続ける**（public リポジトリの run ログは誰でも読める）。日次 sweep で縛れるのは
  ブランチ側だけなので、**機微を取得しうるものを public 経路に流さない**という原則
  （→「モード」節）はログ側にも同じだけ効く。集約モードで公開時間を実際に縮めたいときは、
  ブランチの TTL ではなくこのリポジトリ設定を下げる。
- **エージェントに要る能力**（この仕組みはツール中立。以下の能力を*何で*満たすかはランタイム依存で、
  GitHub の MCP ツール・`gh` CLI・REST API のどれでもよい）:
  - **対象リポジトリの `net-fetch` workflow を `workflow_dispatch` で起動できる**こと（`actions:write` 相当）。
  - **結果を読み戻せる**こと。満たし方は2通りあり、どちらでもよい（→ 手順5）: 対象リポジトリの
    **結果ブランチのファイルを読める**（`git fetch` かコンテンツ取得 API）、または**ジョブログの本文を
    取得できる**（GitHub の MCP ツール等）。
  - 集約モードを使うなら追加で、**ops-runner をセッションから参照できる**こと。これは Claude Code on the web の
    `add_repo`（別リポジトリをセッションに足す機能）を前提にした経路。この機能を持たないエージェント
    （Codex / Gemini CLI / OpenHands / Qwen / Cline 等）は、代わりに ops-runner へ dispatch/読み取りできる資格情報を
    別途持つ必要があり、無ければ**集約モードは実行できない**（→ 下記モード節。実行できないことを分散モードで
    回避しない。停止してユーザーに依頼する）。
  - **上記いずれかを満たせないときは、そこで停止してユーザーに依頼する**（MUST）。足りない能力を回避しようと
    別モードや別経路へ勝手に切り替えない（MUST NOT。可視性・機微性を無視したモード選択になるため。→ モード節）。
- **実行リポジトリの選択（モード）**——どちらで起動するかで可視性と枠消費が決まる:
  - **集約**: public な計算基盤 **ops-runner** で起動する。GitHub Actions 分は無料。ただし**結果は ops-runner の
    結果ブランチとジョブログ＝世界公開**に落ちる（揮発するが、失効するまでは公開）。→ public に晒してよい取得のみ。
    共通ベース allowlist だけが効くので、機微ドメインは構造的にここを通れない。
  - **分散**: 作業中の **private リポジトリ自身**で起動する。結果はそのリポジトリの結果ブランチとジョブログ
    （ともに非公開）に留まる。共通∪固有 allowlist が効くので機微ドメインも取得できる。private リポジトリの
    月枠を消費する。
  - 現状の既定は **集約**（枠が逼迫しているため）。public に晒せない取得だけ分散にする。
    枠残量による集約/分散の自動選択（quota-gate）は将来の共通基盤で足す（この手順・workflow は変更不要）。
    ただし集約は ops-runner をセッションから参照できること（Claude Code on the web の `add_repo` 等）が前提。
    **その手段（および ops-runner への dispatch/読み取り資格情報）を持たないエージェントは、集約が正しい取得
    （＝機微でない）では停止してユーザーに集約実行を依頼する**（MUST）。能力不足を分散モードで回避しない
    （MUST NOT。モードは可視性・機微性で選ぶ原則を崩し、public 相当の取得を private 枠・非公開の結果ブランチに
    落とすため）。分散を使うのは取得内容が機微で分散が正しいときだけ。
  - **分散モードで起動する前に、Actions 月枠の逼迫状態を確認する**（MUST）。手順と信号の読み方は
    [`docs/actions-quota.md`](actions-quota.md)（ops-sync が billing API で実測し、`ci-logs` の
    `quota/actions/actions.json` に粗い state を公開している）。**`ok` 以外（`tight` / `exhausted` / `unknown`）
    なら分散モードで dispatch しない**（MUST NOT）——停止してユーザーに判断を仰ぐ。枠が尽きた状態での
    実行は run の失敗に留まらず、spending limit の設定次第で**実費課金**につながる。
  - 枠の状態を**エージェントが推測で埋めない**（MUST NOT）。信号が無い・古い場合は `unknown`＝逼迫扱い
    （同 doc の手順2・3）。deploy workflow の run が `skipped` 続きかどうか等の**間接判定を根拠にしない**
    （MUST NOT。退避スイッチの入れ忘れを「余裕あり」と誤読するため、実測信号に一本化する）。
  - **モードは可視性・機微性（将来は枠残量）だけで選ぶ**（MUST）。取得先が allowlist に無いこと・
    共通リスト追加の非同期手続き（提案→同期→マージ）を避けたいことを理由に、**分散モードへ切り替えない**
    （MUST NOT）。モード切り替えを allowlist の回避手段に使わない。

## 手順

1. **モードと実行リポジトリを決める**（上記）。集約なら対象は `65edh5ih/ops-runner`、分散なら作業中リポジトリ。
2. **集約モードで ops-runner を使うなら、セッションから ops-runner を参照できるようにする**。エージェント起点で勝手に
   追加しない（MUST NOT）——ユーザーに「`65edh5ih/ops-runner` をこのセッションに追加して取得に使いますか？」と
   はい/いいえで確認し、承諾を得てから追加する（Claude Code on the web なら `add_repo`。→ `docs/cross-repo-tasks.md`
   と同じ作法）。**この手段（別リポジトリのセッション追加）を持たず、ops-runner への dispatch/読み取り資格情報も
   無いエージェントは集約モードを実行できない**。このとき能力不足を分散モードで回避しない（MUST NOT）——
   モードは step 1 のとおり可視性・機微性だけで選ぶ。機微でない（集約が正しい）取得なら、**ここで停止して
   ユーザーに集約実行（repo 追加か ops-runner への dispatch/読み取り）を依頼する**（MUST。勝手に分散へ落とすと、
   local allowlist だけにあるホストを step 3 が許可扱いして共通 allowlist のユーザー判断を素通りし、public 相当の
   取得を private 枠・非公開の結果ブランチに落とす）。分散モードで起動するのは、step 1 で取得内容が機微＝分散が
   正しいと判断したときだけ。
3. **取得先が allowlist に無ければ、ここで停止してユーザーに手動追加を依頼する**（MUST）。エージェントが
   勝手に (a) 分散モードへ切り替えて回避する・(b) 自分で allowlist にドメインを足して続行する、のは**しない**
   （MUST NOT）。**allowlist に何を許すかはユーザーが決める**。依頼には「どのファイルに何を足すか」を明示する:
   - **共通ベースに足す**（＝ ops-sync 側の変更）: `shared/.github/net-allowlist.txt` が**唯一の正本**。
     ops-runner や consumer に届く同名ファイルは sync が配る複製なので、直しても効かない（触らない。MUST NOT）。
     **正本を直す経路（ops-sync へ直接 PR / `種別: shared-file` の outbox 提案）と、その選び方は
     [`docs/outbox-proposal.md`](outbox-proposal.md) に従う**（MUST）——どちらの経路でも**追加を決めるのは
     ユーザーで、入るのは ops-sync 側の人間のマージ**という上の要求は変わらない。ここで足りないのは
     **正本のある ops-sync** への手で、step 2 でセッションに足した実行先の ops-runner とは別物
     （ops-runner の承諾はここには使えない。allowlist の正本を直せるのは ops-sync だけ）。
     **機微を取得しうるドメインは共通ベースに入れない**（world-public な集約経路を通ってしまう。ただし
     「ドメイン自体が機微か」で判断する——多数ユーザーの公開コンテンツを配信する汎用CDNは、たまたま
     今回取得したい個別コンテンツが私的でも、ドメインとしては機微ではない。個別コンテンツの機微性は
     ここではなくモード選択（集約/分散、step 1）で扱う）。
   - **リポジトリ固有に足す**: そのリポジトリの `.github/net-allowlist.local.txt`。**public リポジトリの固有
     allowlist にも機微ドメインを書かない**（public 実行の結果は公開に落ちる。MUST NOT）。
   - 完了条件: ユーザーが追加し、同期反映（共通ベースの場合）を確認してから net-fetch を実行する。
     追加されるまで実行しない。
4. **workflow を起動する**。対象リポジトリの `net-fetch` workflow を `workflow_dispatch` で、
   `url` と一意の `request_id` を渡して実行する（`method` 既定 GET）。**workflow を回す git ref は、dispatch の
   手段によらず必ず対象リポジトリの既定ブランチ（通常 `main`）を指す**（MUST）。現在ブランチや feature ブランチの
   ref で回すと、レビュー済みでない `net-fetch.yml`・allowlist のコピーが走るため、既定ブランチ以外の ref を
   渡さない（MUST NOT）。**dispatch はエージェント自前の GitHub 資格情報で行う**——具体的な手段はランタイム依存で、
   GitHub の MCP dispatch ツール・`gh workflow run`・REST の `POST .../actions/workflows/net-fetch.yml/dispatches`
   のどれでもよい（consumer 側に dispatch 用トークンを置かない＝ルール正本への増幅経路を作らない）。既定ブランチ
   ref の満たし方は手段ごとに異なる（が、既定ブランチを指すこと自体は上記 MUST）: REST は body に `ref`（既定
   ブランチ名。例 `main`）を含める——無いと GitHub は 422 を返し run が作られない。`gh workflow run` は
   `--ref <既定ブランチ>` を明示する——未指定でも既定ブランチだが、別ブランチを渡さないよう明示する。MCP
   dispatch ツールは ref パラメータに既定ブランチを渡す。**dispatch する手段が無ければ、ここで停止して
   ユーザーに依頼する**（MUST。回避のために別経路を勝手に作らない）。
   - 完了条件: run が completed になる。ジョブは allowlist 外や secret 検出でも**失敗しない**（弾いた事実を
     結果に残して緑で終わる）。赤で終わるのはインフラ的 error のときだけ。
5. **結果を読み戻す**（MUST）。読む内容はどちらの出口でも同じ:
   - `status.txt` … 1行目が `ok` / `rejected` / `error`（rejected は2行目に理由）。
   - `response.txt` … 取得本文（secret は伏字済み。`ok` のときのみ）。
   - `meta.txt` … url・http ステータス・生成時刻。

   **出口は2つあり、自分のランタイムで満たせるほうを使う**（どちらも同一内容。速いほうでよい）:
   - **結果ブランチを読む**: `net-fetch-results` の `net-fetch/<request_id>/`
     （`git fetch origin net-fetch-results` してから読むか、コンテンツ取得 API で該当パスを取る）。
   - **ジョブログを読む**: run のログ本文を取得できるなら、`fetch` ジョブ末尾の
     `===== NET-FETCH META BEGIN =====` 以降に meta と応答本文がそのまま出ている（ブランチを取得せずに
     1回で読める）。応答本文は既定 256KiB で打ち切られ、超過分は結果ブランチのスライスにのみ入る
     （打ち切られた旨がログに出る）。
   - 完了条件: `status.txt` が `ok` で `response.txt` に本文がある。`rejected` なら理由に従い allowlist 追加
     などをして `request_id` を変えて再実行する。
   - **どちらの出口も使えないときは、停止してユーザーに依頼する**（MUST）。読めないことを理由に、
     取得できたはずの内容を推測で埋めない（MUST NOT）。

## 縛り（この仕組みが構造的に保証すること）

- **secret を fetch に含められない**: 取得ステップの env に secret を一切載せない（クリーンルーム）。
  加えて request（URL・クエリ）に secret パターンや `token=`/`access_token=` 等が現れたら**送信前に拒否**、
  応答本文・ヘッダに現れた secret パターンは**publish 前に伏字**。認証が要る取得は原理的に通らない。
- **allowlist 外へ行けない**: ホスト完全一致か `*.suffix` のみ許可。https 以外・URL 内資格情報・IP リテラル・
  `localhost`・クラウドメタデータ（`169.254.169.254` 等）は allowlist と無関係に常に拒否。リダイレクト追従は
  無効（非許可先への 302 迂回を防ぐ）。
- **機微は public 経路を通れない**: 集約モードの判定は共通ベース allowlist のみ。機微ドメインはそこに無い
  ため、機微取得は private リポジトリの分散モードでしか成立しない（配置がルールを強制する）。
- **取得結果が git 履歴に堆積しない**: 結果ブランチは毎回 orphan 1コミットに書き換えられる。削除が
  ツリーにしか効かず履歴に残る恒久ログ（`ci-logs`）とは別扱いにしてある。
  **ただし「一定期間で必ず消える」は保証ではない**（構造的に保証されるのは上の「履歴に堆積しない」まで）。
  TTL 失効が走るのは「次の書き込み」と「日次 sweep」で、sweep は public のみ——**private の休眠中は
  最後のスライスが次の取得まで残り、上限が無い**。ジョブログの写しはさらに別寿命
  （Artifact and log retention・既定 90 日）で、TTL では消えない。確実に消すなら結果ブランチを手で削除する
  （`git push origin --delete net-fetch-results`）。詳細は上の「結果ブランチ」節。

## よくある失敗

- **403/407 を「報告して終わり」にして、この手順に進まない**: egress で弾かれた事実を完了報告に書くのは
  別ルール（共通ブロック「外部 URL アクセスの報告」）の要求であって、それを果たしても**取得は完了していない**。
  **403/407 はこの手順の発火トリガそのもの**（→「いつ使うか」）。取得が作業に必要なら、報告に加えて step 1 の
  モード選択に入る（MUST）。「ブロックされたので確認できませんでした」を結論にして作業を終えない（MUST NOT）。
- **「許可リスト」をエージェント実行環境側の egress 設定と取り違える**: 実行環境にもドメイン許可リストが
  ある場合があるが（例: Claude Code on the web の環境設定の Allowed domains）、**net-fetch が読むのは
  リポジトリ内の `.github/net-allowlist.txt` と `.github/net-allowlist.local.txt` だけ**で、両者は無関係。
  実行環境側に足しても net-fetch の allowlist 判定は変わらない（逆も同じ）。step 3 でユーザーに追加を
  依頼するときは、**どちらの層のどのファイルか**を取り違えないこと（MUST）。共通ベースの正本は
  ops-sync の `shared/.github/net-allowlist.txt` の1ファイルで、consumer 側に配布された同名ファイルは
  複製なので編集しても効かない。
- **結果の出口を GitHub Actions の artifact に変えようとする**: 一見「`retention-days` で自動失効するので
  揮発させるのに最適」に見えるが、**エージェントからは読めない**（MUST NOT: 出口を artifact に変える）。
  artifact と run ログの zip はダウンロード URL が `results-receiver.actions.githubusercontent.com` や
  blob ホストへ 302 し、egress 制限下の実行環境はこれらを拒否する（実測: CONNECT に 403・到達不可）。
  `gh run download` も REST も同じホストに当たるため、全エージェントで読み戻せなくなる。
  **egress 制限下で確実に届くのは git（`git fetch`）と `api.github.com` だけ**——だから出口はブランチと
  ジョブログの2つで、揮発は artifact ではなく TTL とブランチ書き換えで実現している。
