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
  - 共通ベース: `.github/net-allowlist.txt`（ai-ops が全リポジトリへ配布。**public な ai-ops にも置かれ、
    集約モードの判定に使われる**ため、機微を取得しうるドメインは**書かない**）。
  - リポジトリ固有: `.github/net-allowlist.local.txt`（各リポジトリが自分で持つ・配布対象外・任意）。
    **機微を取得しうるドメインはここ（private リポジトリのローカル）にだけ書く**。
  - 記法: 1行1ホスト。完全一致か `*.example.com`（サブドメインのみ・素の `example.com` には不一致）。
- **`<request_id>`**: `[A-Za-z0-9._-]+`。結果スライスのパスになる。取得ごとに一意にする（衝突回避）。
- **エージェントに要る能力**（この仕組みはツール中立。以下の能力を*何で*満たすかはランタイム依存で、
  GitHub の MCP ツール・`gh` CLI・REST API のどれでもよい）:
  - **対象リポジトリの `net-fetch` workflow を `workflow_dispatch` で起動できる**こと（`actions:write` 相当）。
  - **対象リポジトリの `ci-logs` ブランチのファイルを読める**こと（`git fetch` かコンテンツ取得 API）。
  - 集約モードを使うなら追加で、**ai-ops をセッションから参照できる**こと。これは Claude Code on the web の
    `add_repo`（別リポジトリをセッションに足す機能）を前提にした経路。この機能を持たないエージェント
    （Codex / Gemini CLI / OpenHands / Qwen / Cline 等）は、代わりに ai-ops へ dispatch/読み取りできる資格情報を
    別途持つ必要があり、無ければ**集約モードは実行できない**（→ 下記モード節。実行できないことを分散モードで
    回避しない。停止してユーザーに依頼する）。
  - **上記いずれかを満たせないときは、そこで停止してユーザーに依頼する**（MUST）。足りない能力を回避しようと
    別モードや別経路へ勝手に切り替えない（MUST NOT。可視性・機微性を無視したモード選択になるため。→ モード節）。
- **実行リポジトリの選択（モード）**——どちらで起動するかで可視性と枠消費が決まる:
  - **集約**: public な **ai-ops** で起動する。GitHub Actions 分は無料。ただし**結果は ai-ops の `ci-logs`
    ブランチ＝世界公開**に落ちる。→ public に晒してよい取得のみ。共通ベース allowlist だけが効くので、
    機微ドメインは構造的にここを通れない。
  - **分散**: 作業中の **private リポジトリ自身**で起動する。結果はそのリポジトリの `ci-logs`（非公開）に留まる。
    共通∪固有 allowlist が効くので機微ドメインも取得できる。private リポジトリの月枠を消費する。
  - 現状の既定は **集約**（枠が逼迫しているため）。public に晒せない取得だけ分散にする。
    枠残量による集約/分散の自動選択（quota-gate）は将来の共通基盤で足す（この手順・workflow は変更不要）。
    ただし集約は ai-ops をセッションから参照できること（Claude Code on the web の `add_repo` 等）が前提。
    **その手段（および ai-ops への dispatch/読み取り資格情報）を持たないエージェントは、集約が正しい取得
    （＝機微でない）では停止してユーザーに集約実行を依頼する**（MUST）。能力不足を分散モードで回避しない
    （MUST NOT。モードは可視性・機微性で選ぶ原則を崩し、public 相当の取得を private 枠・非公開 `ci-logs` に
    落とすため）。分散を使うのは取得内容が機微で分散が正しいときだけ。
  - **モードは可視性・機微性（将来は枠残量）だけで選ぶ**（MUST）。取得先が allowlist に無いこと・
    共通リスト追加の非同期手続き（提案→同期→マージ）を避けたいことを理由に、**分散モードへ切り替えない**
    （MUST NOT）。モード切り替えを allowlist の回避手段に使わない。

## 手順

1. **モードと実行リポジトリを決める**（上記）。集約なら対象は `65edh5ih/ai-ops`、分散なら作業中リポジトリ。
2. **集約モードで ai-ops を使うなら、セッションから ai-ops を参照できるようにする**。エージェント起点で勝手に
   追加しない（MUST NOT）——ユーザーに「`65edh5ih/ai-ops` をこのセッションに追加して取得に使いますか？」と
   はい/いいえで確認し、承諾を得てから追加する（Claude Code on the web なら `add_repo`。→ `docs/cross-repo-tasks.md`
   と同じ作法）。**この手段（別リポジトリのセッション追加）を持たず、ai-ops への dispatch/読み取り資格情報も
   無いエージェントは集約モードを実行できない**。このとき能力不足を分散モードで回避しない（MUST NOT）——
   モードは step 1 のとおり可視性・機微性だけで選ぶ。機微でない（集約が正しい）取得なら、**ここで停止して
   ユーザーに集約実行（repo 追加か ai-ops への dispatch/読み取り）を依頼する**（MUST。勝手に分散へ落とすと、
   local allowlist だけにあるホストを step 3 が許可扱いして共通 allowlist のユーザー判断を素通りし、public 相当の
   取得を private 枠・非公開 `ci-logs` に落とす）。分散モードで起動するのは、step 1 で取得内容が機微＝分散が
   正しいと判断したときだけ。
3. **取得先が allowlist に無ければ、ここで停止してユーザーに手動追加を依頼する**（MUST）。エージェントが
   勝手に (a) 分散モードへ切り替えて回避する・(b) 自分で allowlist にドメインを足して続行する、のは**しない**
   （MUST NOT）。**allowlist に何を許すかはユーザーが決める**。依頼には「どのファイルに何を足すか」を明示する:
   - **共通ベースに足す**（＝ ai-ops 側の変更）: ユーザーが `shared/.github/net-allowlist.txt`（**唯一の正本・
     手編集はここだけ**）に足して main へマージ→同期されると効く（consumer から出すなら `種別: shared-file` の
     outbox 提案。→ `docs/outbox-proposal.md`）。ai-ops 自身の集約実行が読む root の `.github/net-allowlist.txt`
     は shared への symlink なので二重編集は不要（consumer には sync が実ファイルで届く）。
     **機微を取得しうるドメインは共通ベースに入れない**（world-public な集約経路を通ってしまう）。
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
5. **結果を読み戻す**。実行したリポジトリの **`ci-logs` ブランチ**の `net-fetch/<request_id>/` を読む
   （`git fetch origin ci-logs` してから読むか、コンテンツ取得 API で該当パスを取る。手段はランタイム依存）:
   - `status.txt` … 1行目が `ok` / `rejected` / `error`（rejected は2行目に理由）。
   - `response.txt` … 取得本文（secret は伏字済み。`ok` のときのみ）。
   - `meta.txt` … url・http ステータス・生成時刻。
   - 完了条件: `status.txt` が `ok` で `response.txt` に本文がある。`rejected` なら理由に従い allowlist 追加
     などをして `request_id` を変えて再実行する。

## 縛り（この仕組みが構造的に保証すること）

- **secret を fetch に含められない**: 取得ステップの env に secret を一切載せない（クリーンルーム）。
  加えて request（URL・クエリ）に secret パターンや `token=`/`access_token=` 等が現れたら**送信前に拒否**、
  応答本文・ヘッダに現れた secret パターンは**publish 前に伏字**。認証が要る取得は原理的に通らない。
- **allowlist 外へ行けない**: ホスト完全一致か `*.suffix` のみ許可。https 以外・URL 内資格情報・IP リテラル・
  `localhost`・クラウドメタデータ（`169.254.169.254` 等）は allowlist と無関係に常に拒否。リダイレクト追従は
  無効（非許可先への 302 迂回を防ぐ）。
- **機微は public 経路を通れない**: 集約モードの判定は共通ベース allowlist のみ。機微ドメインはそこに無い
  ため、機微取得は private リポジトリの分散モードでしか成立しない（配置がルールを強制する）。

## よくある失敗

- （まだ無し。実際に起きたら追記する。）
