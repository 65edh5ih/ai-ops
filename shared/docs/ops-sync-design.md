# ops-sync 設計ドキュメント

全リポジトリ（consumer）共通の **運用ルール**・**共通インフラ（ファイル）**・**リポジトリ横断タスク**を、
ここ ops-sync を単一の正（source of truth）として各 consumer へ自動配布するための仕組み。手動リレー
（外部ツールへのコピペ等）を不要にし、リポジトリ間のドリフトを構造的に防ぐのが目的。

> **ops-sync 内での正本パス**: `shared/docs/ops-sync-design.md`（`apply-shared.mjs` により各 consumer へ `docs/ops-sync-design.md` として配布）。

## 解決したい問題

- 複数リポジトリ（nikki-san / private …）で AI エージェントに**同じ共通ルールを確実に効かせたい**。
- だが各エージェントのセッションは**原則 1 セッション 1 リポジトリ**で、兄弟リポジトリのメモリ
  （AGENTS.md / CLAUDE.md）は自動ロードされない（例外は「前提・限界」のマルチリポジトリセッションの項。
  設計の前提は変わらない）。→ 唯一堅牢な方法は、**共通ルールを各リポジトリの
  AGENTS.md に物理的に存在させる**こと。
- 同じ制約から「別リポジトリでの作業依頼」も手元に物理的に届ける必要がある（`.ops-sync/tasks/`）。
- 手動コピペは flow であって stock にならず、直し忘れ・コピペずれでドリフトする。

## なぜ「双方向同期」ではなく「配布＋提案」なのか

共通ファイルを複数リポジトリで相互同期すると「書ける場所が複数化 → 多書き込みドリフト・コンフリクト」が
起きる。そこで方向を非対称にし、**各ファイルの書き手を常に1人**に保つ:

- **下り（配布）**: ops-sync → 全 consumer。ops-sync の main に入ると各 consumer に同期 PR が立つ。
  **内容の承認は ops-sync に入る前に済んでいる**ので、同期 PR は自動マージしてよい（下記 MERGE_MODE）。
  同期 PR は正本の複製を配るだけで、そこで新しい内容が生まれることはない。
- **上り（提案）**: consumer → ops-sync。consumer のエージェントは**配布された複製を書き換えず、正本のある
  ops-sync 側へ変更を出す**。出し方は2通り——ops-sync をセッションに追加できるなら正本へ直接 PR、できなければ
  `.ops-sync/outbox/` に「提案」を置いて collect に取り込ませる（→ `docs/outbox-proposal.md`）。どちらでも
  **エージェントは自分でマージしない**。正本に入る条件は経路で分かれる:
  - **直接 PR** … ops-sync でのオーナーのレビュー付きマージ。
  - **outbox 提案** … 提案元が private リポジトリで、かつ前提が変わっていないと機械確認できたものは
    **自動マージ**（→ 下記「上りの認可」）。承認は*提案元でオーナーが提案ファイルを含む PR を main へ
    マージした時点*で済んでおり、取り込み PR の自動マージは同じ変更を二度承認させないための自動化。
    条件を満たさないもの（提案元が public・ベース不一致/欠落・常時層の肥大化など）は
    **オーナーのレビュー待ち**になる。

| ファイル | 唯一の書き手 |
|---|---|
| `AGENTS_COMMON.md`・`shared/**`・`tasks/**` | オーナーのマージ。直接 PR は ops-sync 側、outbox 提案は提案元 consumer 側の PR がその承認点で、private 発かつ機械確認を通れば ops-sync の取り込み PR は自動マージ＝計1回（public 発・機械確認に引っかかった場合は ops-sync 側でもレビュー＝計2回）。→「上りの認可」 |
| consumer の `AGENTS.md` マーカー区間 | ops-sync の sync CI |
| consumer の `.ops-sync/sync-manifest.txt` に列挙されたファイル | ops-sync の sync CI |
| consumer の `.ops-sync/outbox/*.md` | その consumer のエージェント |
| 各リポジトリの `docs/history-inbox/<...>.md`（履歴フラグメント） | 新規1ファイル＝そのリポジトリのエージェント（既存ファイルには触れない） |
| 各リポジトリの `docs/AI_TASK_HISTORY.md` | inbox の統合・アーカイブ移動とも ops-sync の archive CI（下記・保守バッチ）。エージェントは直接編集しない |
| private consumer の `.ops-sync/codex-review-inbox.md`／private の `.ops-sync/codex-review-inbox-all.md` | ops-sync の codex-review-inbox CI（下記「Codex レビューの取りこぼし対策」）。人もエージェントも編集しない |

## 配布物の三層＋タスク

1. **常時必要な共通ルール（テキスト）** — 正本 `AGENTS_COMMON.md`。`apply-common.mjs` が各 consumer の
   `AGENTS.md` の `OPS-SYNC:COMMON` マーカー区間に**埋め込む**（開始・終了マーカーが両方とも無ければ末尾に追記＝初回配線。
   マーカーの状態は区間を選ぶ前に全数検査し、**健全と認めるのは「新旧どちらか一方の組が start→end の順にちょうど1組」か
   「どちらも皆無」だけ**——片方だけ・順序逆・同じマーカーの重複・新旧の組が同時に存在、はいずれも失敗させる。
   黙って追記や部分置換に落とすと、壊れたマーカーと古い本文が残ったまま共通ブロックが増え、規約が二重に載るため）。
   全 consumer の全タスクのコンテキストコストに乗るため最小限に保つ（上りの `common-block-edit`
   取り込み PR には、この層のサイズ増減〔文字数・概算トークン〕が自動記載され、マージ判断の場で
   肥大化が見える）。
2. **特定タスクでのみ要る共通 doc** — 正本 `shared/docs/<name>.md`。consumer の `docs/<name>.md` へ配置。
   常時層からは consumer パス `docs/<name>.md` で参照する。手順系 doc（SOP）は書式規約
   `docs/sop-format.md` に従って書き、`shared/.claude/skills/<name>/SKILL.md` の薄い skill ラッパーを
   添えると、各エージェントが該当タスクで自動発火できる（本体は常に `docs/` 側。SKILL.md はポインタのみ）。
   各エージェント向けミラー（`.codex/skills/`・`.openhands/skills/`・`.gemini/skills/`・
   `.agents/skills/`〔Antigravity〕・`.qwen/skills/`〔Qwen Code〕・`.cline/skills/`〔Cline〕）は
   `apply-shared.mjs` が**配布時に正本から自動生成**する。
   以前は ops-sync 側に正本への symlink を1エージェントぶんずつ手で置いていたが、完全に機械的な複製で
   張り忘れのドリフト源だったため撤去した（新エージェント対応はスクリプトの一覧への追加1行）。
   Gemini CLI に AGENTS.md を読ませる方法は
   「前提・限界」のエージェント別入口を参照（`GEMINI.md -> AGENTS.md` の入口 symlink＝`apply-entrypoints.mjs`）。
   OpenHands は V1 で `.openhands/skills/` を読むが **V0 は読まない**（かつ AGENTS.md も既定では読まない）。
   そこで、常時ロードされる repo microagent `shared/.openhands/microagents/repo.md` を配布する。中身は
   「作業前に AGENTS.md を読んで従え／詳細手順は `docs/` 参照」というポインタのみ（ルール本体は書かない）。
   AGENTS.md 側の常時層に各手順書の発火トリガ＋ポインタがテキストで入っているため、V0 でも
   AGENTS.md → `docs/<name>.md` の参照で手順書層をカバーできる（skill の自動発火は V1 で効く）。
3. **共通インフラ（実ファイル）** — 正本 `shared/` 配下に consumer のパスをミラー
   （例: `shared/.github/actions/publish-ci-logs/action.yml`）。同じ相対パスへ配置。
   実行ファイル（hook・スクリプト）も同様に配れる: `apply-shared.mjs` は正本の**実行ビットを保持**して
   配布する（例: `shared/.claude/hooks/session-start.sh`）。ただし hook を**起動する**登録
   （consumer の `.claude/settings.json` の `SessionStart` 等）は repo ローカルで**配布対象外**——
   すでにその登録がある consumer は配布された実体をそのまま拾う（新規に効かせたい repo では登録を1回足す）。
   `session-start.sh` は githooks 有効化＋（`docs/AI_CONTEXT.md` があれば全文注入）。AI_CONTEXT は「真の必読」
   ＝実質どのタスクでも要るのでフックで確実に載せる（この repo に無ければ skip＝現状 nikki-san のみ発火）。
   **タスク履歴は注入しない**: 毎回は要らず（過去参照タスクのときだけ要る）、どこに何があるかは常時ロードの
   AGENTS.md「タスク履歴（短期記憶）」にあるので on-demand で読む（→ `docs/task-history.md`）。
   履歴フラグメントは配布スクリプト `shared/scripts/new-task-history.mjs`（consumerでは
   `scripts/new-task-history.mjs`）で作る。ブランチ名は実行環境によって `work` のような汎用名になりうるため
   一意性の根拠にせず、UTC時刻＋12桁の暗号学的ランダムIDと排他的作成で並行ブランチ間の衝突を避ける。
4. **リポジトリ横断タスク** — 正本 `tasks/<owner>/<repo>/*.md`。**その consumer だけ**の
   `.ops-sync/tasks/` へ配置。運用は `docs/cross-repo-tasks.md`。

2〜4 は `apply-shared.mjs` が配布し、配布済み一覧を consumer の **`.ops-sync/sync-manifest.txt`** に記録する。
**前回 manifest にあって今回の配布物に無いパスは削除**するので、shared/ での撤去・改名やタスク消化も
consumer へ伝播する（追加しかできない実装だと撤去がドリフトになる）。manifest 導入前から consumer に
ある unmanaged ファイルの撤去は `sync-deletions.txt`（トゥームストーン）に旧パスを列挙する。

## コンポーネント

| ファイル | 役割 |
|---|---|
| `AGENTS_COMMON.md` | （下り・ルール）共通ルール本体。ここだけ編集する |
| `scripts/apply-common.mjs` | （下り・ルール）consumer の AGENTS.md マーカー区間へ反映 |
| `scripts/apply-entrypoints.mjs` | （下り・配線）consumer に `CLAUDE.md` / `GEMINI.md` → `AGENTS.md` の入口 symlink を張る |
| `shared/**` / `tasks/**` | （下り・ファイル）consumer へ配布する実ファイル・タスク |
| `scripts/apply-shared.mjs` | （下り・ファイル）shared/tasks の配置（実行ビット保持）＋manifest 差分による削除伝播＋skill ミラーの自動生成 |
| `shared/scripts/new-task-history.mjs` | （下り・履歴）時刻＋ランダムIDで一意な履歴フラグメントを排他的に新規作成する共通スクリプト |
| `scripts/new-task-history.mjs` | ops-sync自身が上記正本をconsumerと同じパスで使うためのsymlink |
| `sync-deletions.txt` | （下り）manifest 導入前の unmanaged ファイルを consumer から撤去する一覧 |
| `.github/workflows/sync.yml` | （下り）main の変更＋cron（1日1回の再適用＝手編集ドリフトの自己修復）で各 consumer へ同期 PR を生成し、MERGE_MODE に応じてマージ |
| `consumers.txt` | 配布先リポジトリ（`owner/repo`） |
| `scripts/collect-outbox.mjs` | （上り）consumer の `.ops-sync/outbox/*.md` 提案を種別に応じて反映（1 consumer 分をまとめて処理・不正な提案は `rejected/` へ差し戻し） |
| `.github/workflows/collect-outbox.yml` | （上り）cron（約6時間ごと）＋手動で起動、取り込み PR＋outbox 掃除 PR を生成。あわせてトゥームストーン掃除（保守）。処理ログ（提案名・却下理由）は**提案元 consumer の `ci-logs`** へ、ops-sync には件数だけ。consumer 側の掃除 PR は `create-pr-quiet` で作る（取り込み・トゥームストーンは ops-sync 自身への PR なので従来どおり `peter-evans/create-pull-request`） |
| `scripts/archive-task-history.mjs` | （保守）`docs/history-inbox/` のフラグメントを `docs/AI_TASK_HISTORY.md` へ統合し、保持量超過分を `docs/history-archive/` へ移す |
| `.github/workflows/archive-task-history.yml` | （保守）cron（1日1回）で ops-sync＋全 consumer を巡回し、未統合フラグメントか超過エントリがあれば統合＋アーカイブ PR を生成・マージ。処理ログ（フラグメント名）は**対象リポジトリの `ci-logs`** へ、ops-sync には件数だけ |
| `scripts/prune-tombstones.mjs` | （保守）`sync-deletions.txt` の役目を終えた行（全 consumer から対象が消えた）を刈る |
| `scripts/codex-review-inbox.mjs` | （信号）全リポジトリの PR から**未 resolve の Codex レビュースレッド**を集め、全体一覧＋**private consumer 分だけ**のスライスに落とす |
| `.github/workflows/codex-review-inbox.yml` | （信号）cron（毎時）＋手動で上記を実行し、全体一覧を private の `.ops-sync/codex-review-inbox-all.md`、private consumer の自分の分を `.ops-sync/codex-review-inbox.md` へ直接 push（内容に変化があるときだけ）。public repo は全体一覧だけ |
| `.github/actions/create-pr-quiet/` | （内部）**他リポジトリへ commit する PR** の作成・更新。git 操作を `run:` の中で行い、出力を詳細ログへ逃がす（`peter-evans/create-pull-request` は変更ファイル名をジョブログへ流すため。下記「ログの公開先は『何についてのログか』で決める」）。ops-sync ローカルで consumer には配らない |
| `shared/.github/actions/publish-ci-logs/` | （下り・ファイル）恒久ログ（`ci-logs` ブランチ）への publish。既定は実行リポジトリだが、`repository:` 入力で**他リポジトリの `ci-logs`** に出せる（下記「ログの公開先は『何についてのログか』で決める」） |
| `shared/.github/actions/publish-ephemeral/` | （下り・ファイル）揮発ブランチへの publish。毎回 orphan 1コミットへ書き換え＋TTL 失効＋`--force-with-lease`。恒久ログ用の `publish-ci-logs` と対（下記「揮発する出力と恒久ログを分ける」） |

consumer 側に必要な配線は**無い**（workflow・Secret とも不要）。consumer を増やすときは
`consumers.txt` への追記と `OPS_SYNC_TOKEN`（PAT）のアクセス対象追加だけ。

## データフロー

### 下り（共通ルール／ファイル／タスクを変える・オーナー起点）

```
ops-sync: AGENTS_COMMON.md / shared/** / tasks/** を編集して main にマージ
        （＋cron 1日1回の再適用: consumer 側で手編集されたドリフトを翌日までに自己修復）
   └─ sync.yml が各 consumer をチェックアウト
        ├─ apply-common.mjs: AGENTS.md のマーカー区間を更新
        ├─ apply-entrypoints.mjs: CLAUDE.md / GEMINI.md → AGENTS.md の入口 symlink を張る
        └─ apply-shared.mjs: shared/** と tasks/<その consumer>/** を配置
                             （skill ミラーは正本 .claude/skills/ から自動生成）、
                             manifest 差分＋sync-deletions.txt のファイルを削除
   └─ 各 consumer に同期 PR（ブランチ ops-sync/sync-common）
        └─ MERGE_MODE=direct なら即マージ / auto なら auto-merge / off なら手動
```

### 上り（consumer 起点の提案・4種別）

```
consumer: エージェントが .ops-sync/outbox/<時刻>-<説明>.md を main に載せる
   └─ collect-outbox.yml（cron 約6時間ごと・手動可）が全 consumer を clone し、
      最古の提案を持つ consumer の提案をまとめて処理
        ├─ common-block-edit : AGENTS_COMMON.md を全文置換（ベースハッシュで鮮度検査・
        │                      常時層サイズの増減を取り込み PR に記載）
        ├─ shared-file       : shared/<対象パス> を全文置換（ベースハッシュで鮮度検査）
        ├─ task              : tasks/<対象リポジトリ>/ に登録
        ├─ task-done         : tasks/<提案元>/<対象ファイル> を削除
        └─ 不正な提案        : .ops-sync/outbox/rejected/ へエラーノート付きで差し戻し
                               （最古に居座って後続を止めない）
   └─ ops-sync への取り込み PR（まとめて1本）＋ 提案元への outbox 掃除 PR を生成
        ├─ 全提案が「ベース一致・常時層の増加が上限内」 → 取り込み PR を自動マージ
        │                                                 → 掃除 PR も自動マージ（outbox が空く）
        └─ 1件でも保留理由あり                          → 両 PR を open のまま残しオーナーのレビュー待ち
                                                          （run を失敗させて気づけるようにする）
→ 下り（sync）に合流して配布
```

書式・鮮度検査（`ベース:`）・自動マージの条件は `docs/outbox-proposal.md`。

**自動マージが見ているのは「提案が書かれた後に前提が変わっていないか」だけ**で、提案内容そのものの
妥当性ではない。後者はオーナーが提案元の PR をマージした時点で承認済み（＝取り込み時の再承認は重複）。
逆にベース不一致・判定不能・常時層の肥大化は**提案時点には存在しない情報**なので、提案元でのマージでは
代替できず、ここで人間に回す。判定不能（`ベース:` の欠落）は「問題なし」ではないので保留側に倒す。

#### 上りの認可（なぜ提案元の可視性で分けるか）

承認点は**オーナーが提案元で提案ファイルを含む PR を main へマージしたこと**（→ `docs/outbox-proposal.md`
の完了条件）。collect が拾うのはその後なので、取り込み PR の自動マージは同じ変更の二度目の承認を省く
自動化であって、承認そのものを省いてはいない。

ただしそれが承認たりうるのは、**main に載る内容の出所がオーナーに限られる**場合だけ。private repo は
そう言えるが、**public repo は誰でも fork して PR を出せる**ので「main に載った」がオーナー由来を
意味しない。よって**提案元が public なら種別によらず ops-sync 側でもレビューする**（＝承認は計2回。
この2回目は冗長ではない）。

これを外すと、任意の consumer の main に提案ファイルを1つ置くだけで、`shared/.github/workflows/` に
任意の workflow を入れて `OPS_SYNC_TOKEN`（全 consumer に Contents:RW＋Workflows:RW）で全 consumer へ
配布できる。これは下記「以前は上りを即時にするため…」で廃した増幅経路を、トークンではなく
**ファイル配置を入口として**再導入することになる。ベースハッシュは鮮度を証明するが出所は証明しない。

可視性の判定は collect の workflow が行い、**判定できなかった repo は public 扱い**にする。
判定ステップ自体が動かなかった run では全 consumer を public 扱いにする（fail closed）——
「public が1件も無い」と「判定していない」を同じ空リストで表すと、関門が黙って消えるため。

### 保守バッチ（決定的な定型作業はエージェントにやらせない）

移動・削除・複製のような**完全に決定的で判断要素の無い作業**は、エージェントのセッション
（＝LLM のトークン）でやらせず、cron の集中バッチが行う。現行の保守バッチ:

- **タスク履歴のアーカイブ**（下記）
- **トゥームストーン掃除**: `sync-deletions.txt` の行のうち、全 consumer の main から対象ファイルが
  消えたものを自動で刈る（`prune-tombstones.mjs`。collect-outbox.yml に同居して、その実行が clone した
  全 consumer をそのまま判定に使う。機械的削除なので PR は自動マージ）。
- **skill ミラーの自動生成**・**sync の cron 再適用**は保守バッチというより下りの一部（上記）。
- **Actions 月枠の信号**・**Cloudflare 月枠の信号**（下記）

#### Actions 月枠の信号

GitHub Actions の月枠は**アカウント単位**で全 private リポジトリが共有する。エージェントが自発的に
private repo の workflow を dispatch する経路（net-fetch の分散モード等）は、枠が尽きていると run の失敗に
留まらず spending limit 設定次第で実費課金につながるため、実行前に読む信号を1つ用意する。

`actions-quota.yml`（cron 6時間ごと）が `actions-quota.mjs` を実行し、billing API で測った使用率を
`ok` / `tight` / `exhausted` / `unknown` の粗い state に落として `ci-logs` の `quota/actions/actions.json` へ publish する。
消費側の手順は `docs/actions-quota.md`（全 consumer へ配布）。

- **ops-sync でだけ測る**（`shared/` に置かず consumer へ配布しない）: 枠はアカウント単位なので測定は1箇所で
  足りる。ops-sync は public なので測定自体が枠を消費しない（枠を測るために枠を食う矛盾を避ける）。
  consumer に billing PAT を配らずに済み、「consumer 側に workflow・Secret を置かない」原則とも整合する。
- **生の使用分数・使用率は publish しない**: ops-sync の `ci-logs` は世界公開なので、band と閾値だけを出す。
- **含有枠の出どころは経路で違う**: 旧 API は `included_minutes` を返すのでそれを使う。enhanced billing
  platform は返さないので repo variable `ACTIONS_QUOTA_INCLUDED_MINUTES`（既定 2,000＝Free）を使う
  ＝**enhanced 経路ではプラン変更時にこの値の更新が要る**。壊れた値は既定へ黙って戻さず `unknown` に
  倒す（設定したつもりの枠と違う枠で測った `ok` を publish しないため）。
- **測れなければ必ず `unknown`**（＝消費側は逼迫扱い）。token 未設定・API 変更・ネットワーク断・応答形の
  変化はすべてここに落ちる。スクリプトが結果を残せず落ちた場合に備え workflow 側にも `unknown` を書く
  保険ステップがある——無いと publish が何もせず `ci-logs` に前回の古い `ok` が残り、消費側がそれを掴む
  fail-open になる。

#### Cloudflare 月枠の信号

GitHub Actions の枠が尽きたときの退避先は Cloudflare だが、**CF 側にも月枠がある**（Free: Pages の
ビルド 500回/月・Workers Builds 3,000分/月。ともにアカウント単位）。GitHub 側だけ見て自動退避すると
今度は CF を溶かして「どこにもデプロイできない」に至るので、対になる信号を持つ。

`cloudflare-quota.yml`（cron 6時間ごと）が `cloudflare-quota.mjs` を実行し、`ci-logs` の
`quota/cloudflare/cloudflare.json` へ publish する。全体 state に加えてリソース別（`pages_builds` /
`workers_build_minutes`）の state も出す——退避先として使えるのがどちらかで判断が変わるため。

- **ops-sync でだけ測る**（`actions-quota` と同じ理由: 枠はアカウント単位・public なので GitHub 枠を
  食わない・consumer に CF トークンを配らない）。
- **ops-sync に置く CF トークンは読み取り専用にする**（MUST NOT: 書き込み権限を持たせる）。ops-sync は
  public で、切替に要る Edit 権限の操作は consumer 側の workflow が自分のトークンで行う。
  なお Workers Builds API は **user-scoped トークン必須**（account-scoped は "Invalid token" になる）。
- **使用率だけで判定しない**: 同じ月内でも設定変更でレートが不連続に変わる（2026-07 の実測では
  Pages の watch paths を絞る前後で 32件/日 → 2件/日）。**直近 N 日の窓**で日次レートを出し、
  残枠が月末まで持たなければ `tight` にする。**月累計 ÷ 経過日数の平均は使わない**（変更の前後を
  またぐと実態とずれる）。
- **枠を消費しないものを数えない**: Pages の `ad_hoc`（`wrangler pages deploy`＝Direct Upload）と、
  watch paths 不一致で `is_skipped` になった deployment は除く。2026-07 は deployment 2,079 件のうち
  課金対象は 94 件だった（4.5%）——ここを取り違えると 20 倍以上ずれる。
- **Workers Builds の分数は推定値**: 使用量を返すエンドポイントが無いため `running_on`〜`stopped_on`
  から算出している。Cloudflare の課金定義と一致する保証は無いので、閾値には余裕を持たせる。
- **測れなければ必ず `unknown`**（＝消費側は逼迫扱い）。ページングが進まない場合も過少カウント＝
  fail-open になるので `unknown` に倒す。

#### 経路の推奨（判断と実行の分離）

`deploy-route-reconcile.yml`（cron 6時間ごと）が上の2信号を読み、**各対象にとって望ましい経路**を
`ci-logs` の `deploy-route/decision.json` に publish する。**切替はしない**。

**判断と実行を分けているのは、public 側に権限を集中させないため**（上の MUST NOT を守る）:

| | 場所 | 資格情報 | 頻度 |
|---|---|---|---|
| 判断 | ops-sync（public） | **不要**（consumer にも CF にもアクセスしない） | 6時間ごと・Actions 分は無料 |
| 実行 | 各 consumer（private） | 自分の CF トークンと変数書き込みトークン | 切替が要るときだけ |

判断側が consumer の状態（policy が `auto` か・CF が実際に出せるか・`HUGO_VERSION` が合っているか）を
**持たない**ことが、資格情報を持たないことと表裏一体になっている。読み手（consumer）が自分で確かめる。

- **推奨は片方向ずつ条件が違う**: `github → cloudflare` は「Actions が逼迫 **かつ** 逃げ先の CF リソースが
  `ok`」、`cloudflare → github` は「Actions が `ok`」だけ（戻る先が空いていれば戻ってよい）。
- **CF は対象の種類に対応するリソースだけ見る**（Pages 対象は `pages_builds`、Workers 対象は
  `workers_build_minutes`）。全体 state は片方が `unknown` だと `unknown` に落ちるので、それで両方を止めない。
- **信号が無い・壊れている・古いときは推奨を出さない**（`route: null`）。推測で動かすと、実態と逆向きに
  倒して枠を焼くか配信を止めるかのどちらかになる。

#### タスク履歴の統合とアーカイブ

エージェントは履歴を `docs/AI_TASK_HISTORY.md` へ直接追記せず、**1エントリ＝1ファイル**で
`scripts/new-task-history.mjs` を使い、
`docs/history-inbox/<YYYY-MM-DD>T<HHMMSS>Z-<タスクスラッグ>-<ランダムID>.md` に置く
（→ `docs/task-history.md`）。全セッションが本体の
先頭行に挿入すると並行 PR が必ずコンフリクトするため、書き込みを別々のパスに散らして衝突を無くす
（changelog の towncrier 型フラグメント）。読む側は本体＋`history-inbox/` の両方を見る。

`archive-task-history.yml`（cron 1日1回）が ops-sync＋全 consumer を巡回し、`archive-task-history.mjs` が
(1) `history-inbox/` のフラグメントを本体へ取り込んでフラグメントを削除（consolidate）、(2) 取り込み後の
保持量超過分を `docs/history-archive/<YYYY>.md` へ移す（archive）。統合すべきフラグメントか超過エントリが
あるリポジトリにだけ PR を生成・マージする。consolidate は本体に既にある同一本文のエントリ（本文全体の
trim 一致）を取り込まず、そのフラグメントは削除して掃除する（重複記録の防止。見出しだけの一致では消さない）。

`docs/history-inbox/` は**配布された `README.md` プレースホルダ**（正本 `shared/docs/history-inbox/README.md`・
apply-shared が全 consumer へ配布）で常に空でない状態に保つ: 全フラグメントを統合するとディレクトリが
空になり、git は空ディレクトリを追跡しないため、これが無いと fresh checkout で「書き込み先」ディレクトリごと
消える。バッチはこの `README.md` を取り込み対象から除外する（`docs/task-history.md` にも明記）。

- **エージェントのセッションでやらない**（統合・アーカイブとも）: 移動は完全に決定的で判断要素が無く、
  LLM（特に軽量モデル）にやらせるとトークンを浪費するうえ大きなファイル編集を壊しやすい（実際に力尽きる事例があった）。
- **consumer 側の push 駆動 workflow にしない**: 即時性は上がるが、「consumer 側に workflow・Secret を
  置かない」原則（上記）を破る。保持量はソフト目標なので1日1回の集中巡回で足りる。
  （下り配布する共有 workflow は `OPS_SYNC_TOKEN` の Workflows:RW で push する＝下表の注記参照。ただし
  それは「ops-sync が正本を配る」下り方向の話で、consumer 側にトリガや Secret を置くこととは別。）

| Secret | 置き場所 | 権限 | 用途 |
|---|---|---|---|
| `OPS_SYNC_TOKEN` | ops-sync のみ | ops-sync＋全 consumer / Contents:RW, PR:RW, Workflows:RW | 下り同期 PR・上り取り込み/掃除 PR の作成、consumer の読み取り |
| `ACTIONS_QUOTA_TOKEN` | ops-sync のみ | アカウント / Plan: Read-only（repo スコープ不要） | Actions 月枠の使用率を billing API で測る（→ 下記「Actions 月枠の信号」） |
| `CLOUDFLARE_QUOTA_TOKEN` | ops-sync のみ | Cloudflare の **user-scoped・読み取り専用**（Pages: Read / Workers Builds Configuration: Read / Workers Scripts: Read） | CF 月枠を測る（→ 下記「Cloudflare 月枠の信号」）。**書き込み権限を持たせない** |
| `CLOUDFLARE_ACCOUNT_ID` | ops-sync のみ | ─ | 同上。public repo のログに出さないため secret で持つ |

> **Workflows:RW が要る理由**: `shared/.github/workflows/`（現状 `branch-cleanup.yml`・`net-fetch.yml`）を consumer へ配布するため。
> GitHub は `.github/workflows/` 配下のファイルを Workflows 権限の無い PAT で push させないので、この権限が
> 無いと当該ファイルを含む同期 PR の作成が失敗する。この権限は「全 consumer の CI を書き換えられる」ため
> blast radius を広げるが、権限が及ぶ範囲は token の Repository access に含まれる repo 群＝既に Contents:RW を
> 持つのと同じ集合なので、Workflows:RW を足しても新たに露出する repo は増えない（fine-grained PAT の
> Repository access を対象 repo だけに絞れば範囲を最小化できる。任意——このアカウントのように全 repo が
> sync 対象になる前提なら All repositories でも実質同じ）。**新たな共有 workflow を増やすときのみこの権限が
> 必要**——共有ファイルが composite action（`.github/actions/`）や doc だけなら Workflows 権限は不要。

> 以前は上りを即時にするため各 consumer に `OPS_DISPATCH_TOKEN`（ops-sync への Contents:RW）を置いて
> `repository_dispatch` していたが、「どの consumer からでもルールの正本に書けるトークン」が増殖する
> 設計だった（consumer が1つ侵害されると全リポジトリへルールを注入できる増幅経路）。ルール訂正に
> 即時性は不要なので cron ポーリングに変更し、consumer 側のトークン・workflow を全廃した。
> ops-sync の main にはブランチ保護を掛けておくこと（PAT による直 push の防止）。

## Codex レビューの取りこぼし対策（未対応在庫の一覧化）

**この一覧が要る条件**: Codex のレビューは**同期 PR がマージされた数分後**に届くことがあり、そのとき
配布変更を出したセッションは終わっている。上り提案由来の取り込み PR には、そもそも提案元セッションが
存在しない。加えて ops-sync 本体の PR には出ず**consumer 同期 PR にだけ出る指摘**があるため、気づくには
全 consumer を見る必要がある。配布物（`shared/`）への指摘を取りこぼすと、欠陥が全 consumer に残る。

**ルールで埋まらない層がある**: ops-sync の `AGENTS.md`「配布変更のダウンストリーム確認」は、**セッションが
生きている間**だけ機能する。届かない層は機械で埋める——ルールと一覧は代替でなく補完の関係にある。

**しくみ**: `codex-review-inbox` workflow（cron 毎時＋手動）が全リポジトリ（consumer＋ops-sync 自身）の
直近の PR を GraphQL で走査し、**未 resolve の Codex レビュースレッド**を集めて、下記2種類の markdown
（全体一覧＋private consumer ごとのスライス）に書き出す。

- **状態を持たない**。「未 resolve のスレッド」そのものがキュー。直して resolve すれば次回実行で一覧から
  消える。別途の管理表を持たないので、一覧と実態がずれない。
- **エントリが消える条件は「resolve された」だけ**（古くなったから、ではない）。直近スキャンは最近更新された
  PR しか見ないので、それだけだと未 resolve のまま窓から外れた指摘が黙って消える——この一覧が防ぐはずの
  fail-open そのものになる。そこで**前回の一覧に載っていた PR を読み戻し、窓の外でも名指しで再確認する**
  （前回の出力が持ち越しの入力を兼ねる＝別の状態ストアを持たずに耐久性を出す）。再確認に失敗した PR は
  「取得失敗」行として残す（読めなかったものを落とさない）。
- **マージ済み PR の未 resolve を最上位に出す**（🔴）。配布済み＝全 consumer に欠陥が残っている状態で、
  最も危険なクラス。**この 🔴 が1件でもあれば run を失敗させる**——一覧はファイルなので、積むだけでは
  誰かが見に行かない限り気づけない。上り提案が自動マージされる経路では取り込み PR を扱うセッションが
  居ないため、ここが唯一の気づき口になる（→「上り（consumer 起点の提案）」）。open PR の指摘（🟡）は
  その PR を見ている者が居るので失敗させない。取得失敗も失敗扱いにする（読めなかったものを
  「指摘ゼロ」と区別できるようにするため）。
- **取得できなかったリポジトリは「取得失敗」行として一覧に残す**。黙って短い一覧を出すと、指摘が無いのか
  読めなかったのか区別できない（fail-open）。
- **cron を回せるのは ops-sync が public だから**（GitHub-hosted runner が無料＝アカウントの Actions 枠を
  消費しない）。private リポジトリで同じことをすると枠を食う。**頻度は毎時**——実行分は無料でも、
  `*/15` のような高頻度スケジュールは GitHub 側で間引かれて発火しない（実測: 3枠連続で run が作られず、
  同時間帯の他 workflow は動いていた）。急ぐときは `workflow_dispatch` で即時に回す。
- **直近スキャンの窓は狭く保つ**（既定3日）。役目は*新しい指摘の発見*だけで足りる——Codex は PR イベントの
  数分後に投稿し、この workflow は毎時回る。一度載ったものは上記の持ち越しが resolve まで守る。
  窓を広げるほど GraphQL のレート（5,000ポイント/時）を食うため、過去分の洗い直しが要るときだけ
  `workflow_dispatch` の `lookback_days` に大きい値を入れて1回流す。

**出力は2つ**（実行は public、成果物の可視性は置き場で分ける）:

- **全体一覧** `.ops-sync/codex-review-inbox-all.md` … **private リポジトリにだけ**置く。全リポジトリ分を
  **リポジトリごとにグループ化**し、各グループにそのリポジトリのセッションへ貼るコピペ用の依頼文を添える
  （人のトリアージ用。1本開けば全体が分かり、あとは貼るだけで各リポジトリに振れる）。
- **リポジトリごとのスライス** `.ops-sync/codex-review-inbox.md` … **private consumer に自分の分だけ**。
  全リポジトリで同じパスなので、共通ブロックの発火トリガを「このリポジトリの `.ops-sync/codex-review-inbox.md`
  を読め」の1文に固定できる（private consumer のセッションでは自分の積み残しを自力で読める）。public の
  `ops-sync` / `ops-runner` は走査対象には残すが、スライスを書かず private の全体一覧だけに載せる。
  workflow は public repo を書き込み先に含めないので、public repo にスライスは存在しない。

置き場をこう分ける理由は2つ:

- ops-sync は世界公開なので、**全リポジトリ分が混ざる全体一覧をここに置けない**。この workflow が ops-sync の
  `ci-logs`（公開）に出すログも**件数と repo 名だけ**にする。さらに public な `ops-sync` / `ops-runner` は
  `main` を PR 必須の ruleset で保護するため、毎時更新のスライス用に bypass を与えたり PR を量産したりしない。
  代わりに両 repo の指摘も private の全体一覧へだけ載せる。
- **issue ではなくファイル**にするのは、どのエージェントでも能力ゼロで読めるようにするため。issue を読むには
  GitHub API アクセスが要り、エージェントのランタイム依存になる（`.ops-sync/tasks/` と同じ「物理的に届ける」
  作法。→「解決したい問題」）。

## 実行基盤の分離（ops-sync と ops-runner）

**エージェントが dispatch する計算は ops-sync で動かさない。** 専用の public な consumer `ops-runner` で動かす
（現状 net-fetch。`consumers.txt` に載っているので、workflow も allowlist も共通ルールも通常の配布で届く）。

**分割線は「計算 vs 配布」ではなく「`OPS_SYNC_TOKEN` が要るか」**:

| | ops-sync | ops-runner |
|---|---|---|
| 起動者 | cron と push のみ | **エージェントが任意に dispatch** |
| 外部からの入力 | 取らない（quota は一次 API のみ） | **任意の外部 URL の中身** |
| Secret | `OPS_SYNC_TOKEN`・quota 用トークン | **無し**（`github.token` のみ） |
| 中身 | sync / collect-outbox / archive / prune / quota 信号 / `shared/` の正本 | net-fetch の実行 |

ops-sync には全 consumer へ書ける `OPS_SYNC_TOKEN` がある。一方 net-fetch は**エージェントが任意のタイミングで
起動でき、任意の外部コンテンツを持ち込む唯一の経路**で、性質がまったく違う。同居していても直ちに穴が
空くわけではない（fetch ジョブに secret を渡さない・`pull_request` トリガが無い・fork PR は承認必須・
main はブランチ保護）が、**その不変条件を workflow 1つ1つのレビューで維持し続ける**必要がある。
リポジトリ境界にすれば構造で保たれ、この種の機能が増えても判断は1回で済む。

archive-task-history のようなバッチは「計算」だが cross-repo write が要るので ops-sync 残留。quota 信号も
cron 専用で外部入力を取らないため残留する（枠はアカウント単位なので測定は1箇所でよい）。

**限界（誤解しないこと）**: この分離は**一方向**。runner に配るには `OPS_SYNC_TOKEN` が runner にも書ける
必要があるので、「runner が ops-sync を触れない」は成立するが「ops-sync が runner を触れない」は成立しない。
守っているのは*鍵のある場所に外部コンテンツを持ち込ませない*ことであって、鍵の影響範囲の縮小ではない。

**`ci-logs` は2箇所になる**: quota 信号は ops-sync、net-fetch の結果は ops-runner。分散モードのエージェントは
「枠の信号は ops-sync、取得結果は実行したリポジトリ」と読み分ける（→ `docs/net-fetch.md`）。

## ログの公開先は「何についてのログか」で決める

ops-sync は public なので、**その `ci-logs` に出したものは世界公開の恒久記録**になる（消しても履歴に残る）。
一方 ops-sync の cross-repo バッチ（sync / collect-outbox / archive-task-history / codex-review-inbox）は
**private consumer の中身を読んで動く**。素直に「実行したリポジトリの `ci-logs`」に出すと、private の
ファイル名・本文が public 側に落ちる。実際 `archive-task-history` は統合・削除したフラグメントのファイル名
（＝private リポジトリのタスクスラッグ）を毎日 ops-sync の `ci-logs` に出していた。

**規則**（手順は `docs/ci-logs.md` 手順A-6）:

- **詳細ログ（対象の中身に由来するもの）は対象リポジトリ自身の `ci-logs` へ**。`publish-ci-logs` の
  `repository:` 入力で宛先を変える。可視性が対象の可視性に自動で一致し、読み手（そのリポジトリで
  作業するエージェント）は自分のリポジトリで読める。
- **実行側（ops-sync）には件数・repo 名・成否・PR URL までのロールアップだけ**。集計値はスクリプトの
  `$GITHUB_OUTPUT` から受け取り、公開用の要約を作り分ける（詳細ログを grep で削らない）。
- quota 信号は**逆に public でなければならない**（`quota/actions/actions.json`）。読み手は全リポジトリの
  エージェントで、public な ops-runner も含む。これを private に移すと「能力ゼロで読める」が崩れる。
  だから band しか出さない（→「Actions 月枠の信号」）。

「宛先を1つの private リポジトリに寄せる」ではなく**対象リポジトリごとに散らす**のは、上の2点
（可視性の自動一致・読み手と同一リポジトリ）が同時に満たせるのはこの形だけだから。Codex レビューの
全体一覧を private に寄せているのは、あれが**人が1本開いてトリアージする成果物**で、読み手も置き場も
1つだから（性質が違う）。

### ジョブログも同じ扱いにする（漏れる経路は3つ）

`ci-logs` の置き場だけ分けても足りない。**public リポジトリの run ログは world-readable** で、しかも
`ci-logs` と違って保持がリポジトリ設定（Artifact and log retention）任せ。ジョブログへ落ちる経路は3つあり、
**最初の1つを塞いだだけでは残り2つから同じものが出る**——`ci-logs` への出力を分離しても、この3つを
すべて塞がない限り公開ログから同じ内容が読める:

1. **自分の `run:` の出力** → `tee` ではなくファイルへリダイレクトする。
2. **`uses:` した action の出力** → 呼び出し側から抑制できない。`create-pull-request` は `git status` /
   `git commit` をそのまま流すので、**対象リポジトリへ commit する PR 作成は `.github/actions/create-pr-quiet`
   に置き換えた**（git 操作を `run:` に持ち込み、出力を詳細ログへ逃がす自前 action）。ops-sync 自身への
   PR（取り込み・トゥームストーン整理）は公開されて当然なので `create-pull-request` のまま——実績のある
   action を必要の無い範囲まで置き換えない。
3. **`with:` に渡す値そのもの**（`uses:` ステップの入力は必ずログに出る） → ブランチ名・タイトルを対象の
   中身から作らない。cleanup ブランチは提案ファイル名の 12 桁ハッシュにしてある（同じ入力で同じ名前になる
   性質は保ちつつ、名前から中身を復元できない）。intake 側は public な ops-sync に立つブランチで、提案内容
   自体が公開 PR になるので slug のまま。

手順は `docs/ci-logs.md` 手順A-6。`create-pr-quiet` は**consumer へ配らない**（`shared/` に置かない）——
必要なのは「public な実行リポジトリから private リポジトリへ commit する」cross-repo バッチだけで、
consumer 側にその状況が無いため。

### 「動かすコード」と「書き換える木」の ref を分ける

cross-repo バッチは**巡回対象に ops-sync 自身を含む**。このとき `actions/checkout` に `repository:` を
渡しても `ref:` を省略すると、それが実行中のリポジトリ自身なら **workflow の ref**（＝dispatch した
ブランチ）が取られる。取った木をそのまま `base: main` の PR にすると、**feature ブランチから手動
dispatch しただけでブランチの差分が main へ自動マージされる**（`MERGE_MODE=direct`）——レビュー前の
コードが main に入る経路になる。

チェックアウトは役割で分ける（MUST）:

- **動かすコード**（スクリプト・ローカル action）… `ref` 省略＝workflow の ref。ブランチから dispatch して
  マージ前に挙動を検証できるのは、この側が workflow の ref を取るからで、これは意図した動作。
- **書き換えて PR にする木**（対象リポジトリのチェックアウト・取り込み用の ops-sync チェックアウト）…
  **`ref: main` を明示**。PR の base と一致させる。

`archive-task-history` は対象チェックアウトを、`collect-outbox` は取り込み用と
トゥームストーン掃除用のチェックアウトを、それぞれ `ref: main` で固定してある
（`collect-outbox` はスクリプト用に `ops-sync-src` を別途チェックアウトする）。

## 揮発する出力と恒久ログを分ける

CI が生む出力には性質の違う2種類があり、**同じブランチに混ぜると片方の要求を満たせなくなる**ので分けている。

- **恒久ログ**（CI ログ・quota 信号）→ `ci-logs` ブランチ／`publish-ci-logs`。追記型で、現在値を読ませ続ける。
- **読んだら用済みの一次データ**（net-fetch の取得結果）→ 専用の揮発ブランチ（`net-fetch-results`）／
  `publish-ephemeral`。毎回 orphan 1コミットへ書き換えるので**履歴に堆積せず**、TTL で失効する
  （TTL は可視性で変える: public 60分・private 3日。理由は下記）。

`publish-ephemeral` の retention は、`slice-root`（既定 `net-fetch`）直下をスライス境界として扱う。
action が直接管理する各スライスには `.published-at` を書き、`slice-root` 直下のディレクトリだけを走査する。
marker を読めて期限切れと判定できたスライスに加え、marker が無い／読めない直下スライスも保持期限を
証明できないため fail-closed で削除する。scheduled sweep は最後のスライスが消えた場合も
空 tree の orphan commit を publish し、揮発ブランチ上に期限切れデータを残さない。

**失効・削除が走る契機は3つ**: ①読了後の cleanup dispatch ②次の書き込み ③毎時 sweep。
③は **public リポジトリでだけ動く**（`net-fetch.yml` の `sweep` ジョブが private を skip する）——
定期 sweep の目的は「TTL を超えて世界公開する時間を最小化する」ことで、結果が非公開な private
consumer では便益が無いのに Actions 分数だけがアカウント枠に課金されるため。

①を実行すれば公開時間は読み取り時間（数分）で終わる。①を**省いた**場合の最大保持はモードで違う:

- **集約モード（public な ops-runner）**: TTL 60分＋sweep の最大1時間 ＝ 約2時間。上段の
  「期限切れデータを残さない」が成立する。**この上限はエージェントに依存しない**（①は最適化で、
  上限を担保しているのは③）。
- **分散モード（private consumer）**: 失効は次の取得時にしか走らないので、休眠中は最後のスライスが
  **次に net-fetch を使うまで**残る（上限なし）。非公開なので世界公開にはならないが、
  「3日で消える」保証は private には無い。

分けた理由は、**git ブランチでは削除が削除にならない**こと。`ci-logs` からファイルを消しても内容は履歴に
残り、ops-sync は public なので取得結果が世界公開の恒久記録として積み上がる。かといって `ci-logs` ごと
orphan 再構築すると quota 信号や archive ログの経緯まで巻き込む。**性質で置き場を分けるのが唯一の解**で、
分けてあれば揮発側はブランチごと捨てられる。

**ただし揮発側でも「削除」は到達不能化どまり**（この設計が保証しないこと）。orphan 書き換え・TTL 失効・
cleanup・ブランチ削除のいずれも、行っているのは**ブランチ先端から辿れなくすること**だけで、到達不能に
なった commit・blob はリモートに残る。GitHub には GC を強制する API が無いため、**ブランチが生きている
間に SHA を記録した相手はその後も取得できる**。つまり揮発ブランチが縮めるのは**堆積と発見可能性**で、
`ci-logs` との差も「履歴に積み上がるか」であって「消せるか」ではない。
**帰結として、public な集約モードに流した取得は publish 時点で恒久的に開示されたものとして扱う**——
機微性の判断は cleanup の有無ではなく**モード選択**（集約か分散か）で行う。cleanup を機微データの
安全弁として設計に組み込まない。

**出口をブランチ以外にはできない**（重要・再検討しないこと）。artifact は `retention-days` で自動失効する
ので一見最適だが、artifact と run ログの zip はダウンロード URL が `results-receiver.actions.githubusercontent.com`
や blob ホストへ 302 し、**egress 制限下のエージェント実行環境はこれらを拒否する**（実測: CONNECT に 403・
到達不可）。`gh run download` も REST も同じホストに当たるので、artifact 化すると全エージェントで結果を
読み戻せなくなる。egress 制限下で確実に届くのは **git（`git fetch`）と `api.github.com`** だけ。
そのため出口は揮発ブランチにし、**揮発は artifact ではなく TTL とブランチ書き換えで実現している**。

**応答本文はジョブログには出さない**。ジョブログは git ブランチではないので揮発ブランチの TTL が効かず、
リポジトリ設定の Artifact and log retention（1〜90日）に従って残る——public な集約モードではそれが
world-readable のまま残り、TTL で縮めた公開時間がログ側で無効になる。ログに出すのは照合用の最小限
（`meta.txt`・本文の `bytes` と `sha256`）だけ。**これで読めなくなるランタイムは無い**: 結果ブランチは
`git fetch` だけでなく**コンテンツ取得 API**でも読めるので、シェルや git を持たず GitHub の MCP ツール
だけのランタイムでも満たせる（かつて本文をログに併載していたのは往復回数を減らす便宜で、
能力の橋渡しではなかった）。

**公開時間を縮める主経路は定期 sweep ではなく「読了後の cleanup dispatch」**。エージェントが結果を
読み終えた直後に `cleanup: 'true'` で同じ workflow を起動し、`publish-ephemeral` の `drop-slice` で
そのスライスを齢に関係なく落とす。これによりブランチ上の滞在は TTL ではなく実際の読み取り時間で終わり、
かつ**使ったときだけ 1 run** なので休眠中の課金がゼロになる（定期 sweep は使わない月も毎日課金される）。
毎時 sweep は cleanup をし損ねたときのバックストップとして public にのみ残す（public の Actions は
無料なので毎時でもコスト 0。private では skip＝分数ゼロ）。

**痕跡は結果ブランチだけではない**。本文をジョブログから外しても、run には `meta`（取得 URL・時刻）と
GitHub が記録する dispatch 入力（`url`/`request_id`）が残り、これらは結果ブランチの TTL の対象外で
Artifact and log retention に従う。そこで **public では毎時 sweep が「1日より古い成功 run」を run ごと
削除する**（`RUN_RETENTION_DAYS`）。ログだけ削除する API では run が残って dispatch 入力の URL が
見え続けるため、run ごと消す。失敗 run は障害調査に要るので残す。**run_id を控える必要はない**——
Actions API が run 一覧を持つので、台帳もエージェントの協力も要らない。帰結として public では
1日より後に「いつ何を取得したか」を遡れない（net-fetch は `ci-logs` に publish しないため）。

**cleanup は「その取得が作りうるスライス」を全部落とす**。`request_id` が構造検査（`[A-Za-z0-9._-]+`）や
secret 判定に引っかかった取得は、結果が `net-fetch/<request_id>/` ではなく
**`net-fetch/_invalid-<digest>/`** へ退避される。この退避先は**生の `request_id` の sha256 先頭12桁**で
決まる——時刻や PID を混ぜると別 run である cleanup 側から再現できず、エージェントが持っている生 ID
からは到達できないため（退避スライスが残ったまま「nothing to drop」で緑になり、手順6の「緑＝外れた」が
嘘になる）。cleanup ジョブは同じ digest を組み立て、`drop-slice`（1行1スライス名）に**通常スライスと
退避スライスの両方**を渡す。生 ID を名前として渡すのは素のスライス名として妥当なときだけで、
不正な ID（`/`・改行を含む等）は digest 側だけを渡す——複数行の ID を素通しすると「複数のスライス名」に
化けて無関係なスライスを消せてしまうため。

この設計は**2つの名前空間を分離して初めて成立する**ので、`request_id` の検証で **`_invalid-` 始まりを
予約**している。予約しないと、ある ID の退避先（例 `foo` → `_invalid-2c26b46b68ff`）を別のリクエストが
そのまま `request_id` に選べてしまい、`foo` の cleanup が**無関係な取得結果を消す**。予約により
`_invalid-*` スライスは退避経路でしか生まれない。

**予約は「作る側」だけに掛け、「消す側」には掛けない**（非対称は意図的）。cleanup 側でも同じ予約を
適用すると、予約導入より前に `_invalid-foo` のような ID で publish されたスライスが**名前で指せなくなり**、
cleanup が緑のまま何も消さない状態になる（public は TTL と毎時 sweep が拾うが、private は次の取得まで
残りうる）。削除は常に安全な方向なので、素のスライス名でありさえすれば受け付ける。

cleanup ジョブが `GITHUB_OUTPUT` へスライス名を渡すときの**デリミタは固定にしない**。
`__NET_FETCH_SLICES__` のような文字列自体が妥当な `request_id` なので、固定デリミタだと入力がその場で
multiline output を閉じ、ステップが落ちて cleanup が何も消さなくなる（`net-fetch.sh` の出力と同じ理由・
同じ対処＝乱数デリミタ＋実出力行との衝突チェック）。

`publish-ephemeral` は `publish-ci-logs` を拡張せず別 action にしてある。挙動が大きく違ううえ
（追記型 vs 毎回書き換え）、`publish-ci-logs` は consumer の deploy 系が依存する敏感な経路だから
（AGENTS_COMMON「敏感なコードの共通化は挙動を変えない形に留める」）。

## 前提・限界

- **リポジトリの可視性**: ops-sync は **public**、作業リポジトリの consumer（nikki-san / private）は **private**、
  計算基盤の consumer（ops-runner）は **public**。ops-sync と ops-runner を public にしているのは GitHub Actions の
  分数節約のため（public repo の GitHub-hosted runner は無料で、運用 workflow・エージェント起点の計算とも
  アカウント枠を消費しない）。帰結:
  - ops-sync に置く一切（git 履歴・outbox 取り込み結果・shared 配布物）は**世界公開**。secret・consumer の
    内部情報（インフラ機密等）を ops-sync に置かない。上りで出す内容（outbox 提案・正本への直接 PR の
    どちらも）に private repo の中身を貼らない。
  - 唯一の機微は `OPS_SYNC_TOKEN`（下記）だが Actions secret なので**可視性変更では露出しない**。かつ
    ops-sync の workflow はどれも `pull_request` では起動しないため、fork PR からトークンを窃取する経路が
    構造的に無い。合鍵保護として **main のブランチ保護**（無料アカウントでは public でのみ enforced。
    archive/collect が自 PR を PAT 自動マージするため**承認必須は 0**）と、Settings → Actions の fork PR
    **「Require approval for all external contributors」**を掛ける。
- consumer の既定ブランチは `main` 前提（sync の base）。
- **マルチリポジトリセッション（「1セッション=1リポジトリ」の例外）**: Claude Code on the web は、
  **ユーザーがセッション内で明示的に依頼**すれば他リポジトリをセッションに追加して読み書きできる
  （例:「`owner/repo` をこのセッションに追加して」。接続中の GitHub アカウントがそのリポジトリに
  アクセスできることが条件）。ただし ①ユーザー起点のみ（エージェントが自発的に追加してはならない）
  ②Claude Code 限定（Codex / Gemini CLI / OpenHands 等に同等機能は無い）③追加リポジトリの AGENTS.md が
  自動ロードされるわけではない。よって**エージェント起点・全エージェント対象の本仕組み
  （配布・outbox・tasks）の設計前提は変わらない**。ユーザーが同席する単発作業（別リポジトリのコードを
  参照しながらの実装など）では、タスク機構を経ずにこの機能を使ってよい。エージェントは他リポジトリの
  参照が必要になったとき「読めません」で終わらせず、対象リポジトリ名を明示したはい/いいえの確認を出し、
  承諾を得てから追加する（承諾＝明示依頼。ルール本体は常時層＝AGENTS_COMMON.md にある）。
- `shared/` 内の symlink は配布時に**実体化**される（`apply-shared.mjs` はファイル内容を読んでコピーする）。
  consumer には通常ファイルとして届く。コピー時に正本の**パーミッション（実行ビット）も保持**するので、
  実行ファイル（hook・スクリプト）は `shared/` 側で `chmod +x` して置けば consumer でも実行可能で届く。skill の各エージェント向けミラーは `apply-shared.mjs` が正本
  `.claude/skills/` から自動生成するので、ops-sync 側に二重配置（symlink 含む）を置かない。それ以外で
  同一内容を複数パスに配りたい場合は ops-sync 側で symlink にしてドリフトを防ぐ。symlink の張り先が
  `shared/` の外だと CI の checkout に依存するため、**張り先も `shared/` 内に置くこと**。
- 初回、consumer に同等のインライン記述がある場合は、その consumer だけ初回手作業で
  「インライン削除＋マーカー挿入」を行う（以降はマーカーで置換され重複しない）。
- 上りの取り込みは**全文置換**なので、複数 doc にまたがる再構成には向かない。その場合は
  ops-sync のセッションで一括編集する（consumer からは `docs/outbox-proposal.md` の該当節参照）。
- collect は1回の実行で、最古の提案を持つ consumer の分をまとめて処理する。別 consumer の提案と、
  同一実行内で衝突する提案（2件目以降の common-block-edit・対象パスが重複する shared-file）は、
  先行の cleanup PR マージ後の実行で処理される。不正な提案は `.ops-sync/outbox/rejected/` へ
  エラーノート付きで差し戻されるため、キューに残って後続を止めることはない。
- 提案・タスクの「なぜ」は frontmatter の `理由:` → 取り込み PR 本文 → ops-sync の PR/git 履歴に残る。
  consumer のエージェントから ops-sync の履歴は見えないため、**consumer 側でも将来参照しそうな判断根拠は
  配布 doc（`shared/docs/`）自体に書き込む**こと。
- エージェントごとに AGENTS.md への入口が違う。**正本は常に `AGENTS.md` 一本**にし、各エージェントを
  そこへ向ける（内容を各ファイルへ複製しない）:
  - Codex は `AGENTS.md` をネイティブに読む。
  - Kimi Code CLI（Moonshot）は `AGENTS.md`（リポジトリ直下・および `.kimi-code/AGENTS.md`）をネイティブに読む
    ため**追加配線ゼロ**で届く。skill は明示呼び出し（`Skill` ツール）でディレクトリからの自動発火機構が無い
    ため、手順書層は OpenHands V0 と同じく AGENTS.md 常時層のトリガ → `docs/<name>.md` 参照でカバーする。
  - Antigravity（Google の agentic IDE）は `AGENTS.md` をネイティブに読む（v1.20.3〔2026-03〕でクロスツール
    標準 AGENTS.md をサポート）。読み込み優先順は `~/.gemini/GEMINI.md`（global）→ `./GEMINI.md` → `./AGENTS.md`
    → `./.agent/rules/*.md`。よってルール本体は**追加配線ゼロ**で届く（consumer の `AGENTS.md` を直接読むうえ、
    Gemini CLI 向けに張ってある `GEMINI.md -> AGENTS.md` 入口 symlink も優先的に拾うため二重に届く）。skill の
    自動発火は `.agents/skills/<name>/SKILL.md`（description マッチのオンデマンド。公式
    `antigravity.google/docs/skills`）に対応するので、他エージェントと同じく `.claude/skills/` を正本とする
    ミラー symlink を `shared/.agents/skills/` にも張って配る。
  - Claude Code は `CLAUDE.md` を読む → `CLAUDE.md -> AGENTS.md` の入口 symlink で同じ AGENTS.md を読む。
  - Gemini CLI は既定で `GEMINI.md` を探す → `GEMINI.md -> AGENTS.md` の入口 symlink で AGENTS.md を読む。
    （`shared/.gemini/settings.json` の `context.fileName` で読ませる案は環境によって効かず〔`/memory show`
    が空〕、symlink 方式に一本化した。Tips「Create GEMINI.md files…」は context が空のとき出るサインで、
    symlink がロードされれば消える。）
  - Qwen Code（Gemini CLI フォーク）は既定の context ファイルとして `QWEN.md` を探すが、リポジトリ直下に
    `AGENTS.md` があれば**それも読む**（公式 memory doc「if your repository already has an `AGENTS.md`
    file … Qwen reads that too」）。よって `QWEN.md -> AGENTS.md` の入口 symlink を張ると同じ共通ブロックが
    QWEN.md と AGENTS.md の両方から**二重ロード**になるため張らない（**native-AGENTS 扱い＝追加配線ゼロ**）。
    skill は `.qwen/skills/<name>/SKILL.md`（description マッチで自動発火）に対応するので、他エージェントと
    同じく `.claude/skills/` を正本とするミラーを `.qwen/skills/` にも配る（`apply-shared.mjs` の
    `SKILL_MIRROR_ROOTS`）。＝入口は native、skill だけミラーする組み合わせ。
  - OpenHands は V0 だと AGENTS.md も `.openhands/skills/` も読まないため、常時ロードの
    `.openhands/microagents/repo.md`（ポインタ）から AGENTS.md へ誘導する。V1 は `.openhands/skills/` も読む。
  - GitHub Copilot は既定で `.github/copilot-instructions.md`（リポジトリ全体のカスタム指示）を常時読む →
    その固定内容ポインタから AGENTS.md へ誘導する（`shared/.github/copilot-instructions.md`）。
  - Continue は `.continue/rules/*.md`（frontmatter `alwaysApply: true` で常時適用）を読む →
    その固定内容ポインタから AGENTS.md へ誘導する（`shared/.continue/rules/ops-sync.md`）。
  - Cursor は `.cursor/rules/*.mdc`（frontmatter `alwaysApply: true` で常時適用）を読む →
    その固定内容ポインタから AGENTS.md へ誘導する（`shared/.cursor/rules/ops-sync.mdc`）。
  - Cline は `.clinerules/`（ディレクトリ配下の Markdown を常時ロード）を読む →
    その固定内容ポインタから AGENTS.md へ誘導する（`shared/.clinerules/ops-sync.md`）。加えて Cline は
    skill（`.cline/skills/<name>/SKILL.md`）を description マッチで自動発火する（v3.48〜。progressive
    loading）ので、他エージェントと同じく `.claude/skills/` を正本とするミラーを `.cline/skills/` にも配る
    （`apply-shared.mjs` の `SKILL_MIRROR_ROOTS`）。＝常時ルールは `.clinerules/` ポインタ、SOP は
    `.cline/skills/` ミラーの二本立て（Gemini / Qwen と同じ構成）。
  - Windsurf は `.windsurf/rules/*.md`（frontmatter `trigger: always_on` で常時適用。1行目から frontmatter）を
    読む → その固定内容ポインタから AGENTS.md へ誘導する（`shared/.windsurf/rules/ops-sync.md`）。
  Copilot / Continue / Cursor / Cline / Windsurf は入口（＝常時ルール層）が**固定内容の実ファイル**（consumer
  非依存・`shared/` の中に置ける）なので、`CLAUDE.md`/`GEMINI.md` のような入口 symlink（`apply-entrypoints.mjs`）
  ではなく `apply-shared.mjs` の通常配布で届く。このうち **Cline だけは skill の自動発火機構を持つ**（上記
  `.cline/skills/`）ので手順書層も skill ミラーで拾える。残り（Copilot / Continue / Cursor / Windsurf）は skill
  自動発火機構が無いため、手順書層は OpenHands V0 と同じく AGENTS.md 常時層のトリガ → `docs/<name>.md` 参照で
  カバーする（ポインタには本体を書かない）。
  `GEMINI.md`/`CLAUDE.md` → `AGENTS.md` の入口 symlink は **`shared/` 経由で配れない**（`apply-shared.mjs` は
  symlink を実体化＝凍結し、かつ AGENTS.md は consumer ごとにマーカー区間が異なる＆ `shared/` の外）。
  そこで **`apply-entrypoints.mjs`** が各 consumer の checkout 内に直接 symlink を張る（sync.yml の1ステップ。
  冪等・既存の実体ファイルは壊さない）。ops-sync 自身の repo 直下にも `CLAUDE.md`/`GEMINI.md -> AGENTS.md` を置く。
