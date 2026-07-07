# ai-ops 設計ドキュメント

全リポジトリ（consumer）共通の **運用ルール**・**共通インフラ（ファイル）**・**リポジトリ横断タスク**を、
ここ ai-ops を単一の正（source of truth）として各 consumer へ自動配布するための仕組み。手動リレー
（外部ツールへのコピペ等）を不要にし、リポジトリ間のドリフトを構造的に防ぐのが目的。

> **ai-ops 内での正本パス**: `shared/docs/OPS_SYNC_DESIGN.md`（`apply-shared.mjs` により各 consumer へ `docs/OPS_SYNC_DESIGN.md` として配布）。

## 解決したい問題

- 複数リポジトリ（nikki-san / private …）で AI エージェントに**同じ共通ルールを確実に効かせたい**。
- だが Claude Code on the web は **1 セッション 1 リポジトリ**で、兄弟リポジトリのメモリ
  （AGENTS.md / CLAUDE.md）は自動ロードされない。→ 唯一堅牢な方法は、**共通ルールを各リポジトリの
  AGENTS.md に物理的に存在させる**こと。
- 同じ制約から「別リポジトリでの作業依頼」も手元に物理的に届ける必要がある（`.ai-ops/tasks/`）。
- 手動コピペは flow であって stock にならず、直し忘れ・コピペずれでドリフトする。

## なぜ「双方向同期」ではなく「配布＋提案」なのか

共通ファイルを複数リポジトリで相互同期すると「書ける場所が複数化 → 多書き込みドリフト・コンフリクト」が
起きる。そこで方向を非対称にし、**各ファイルの書き手を常に1人**に保つ:

- **下り（配布）**: ai-ops → 全 consumer。ai-ops の main に入ると各 consumer に同期 PR が立つ。
  **内容のレビューは ai-ops のマージ時に済んでいる**ので、同期 PR は自動マージしてよい（下記 MERGE_MODE）。
- **上り（提案）**: consumer → ai-ops。consumer のエージェントは `.ai-ops/outbox/` に「提案」を置くだけで、
  正本を直接書き換えない。取り込みは ai-ops 側の1回の人間レビュー付きマージに集約。

| ファイル | 唯一の書き手 |
|---|---|
| `AGENTS_COMMON.md`・`shared/**`・`tasks/**` | ai-ops でのマージ（人間がレビュー） |
| consumer の `AGENTS.md` マーカー区間 | ai-ops の sync CI |
| consumer の `.ai-ops/sync-manifest.txt` に列挙されたファイル | ai-ops の sync CI |
| consumer の `.ai-ops/outbox/*.md` | その consumer のエージェント |

## 配布物の三層＋タスク

1. **常時必要な共通ルール（テキスト）** — 正本 `AGENTS_COMMON.md`。`apply-common.mjs` が各 consumer の
   `AGENTS.md` の `AI-OPS:COMMON` マーカー区間に**埋め込む**（マーカーが無ければ末尾に追記＝初回配線）。
   全 consumer の全タスクのコンテキストコストに乗るため最小限に保つ。
2. **特定タスクでのみ要る共通 doc** — 正本 `shared/docs/<name>.md`。consumer の `docs/<name>.md` へ配置。
   常時層からは consumer パス `docs/<name>.md` で参照する。手順系 doc（SOP）は書式規約
   `docs/sop-format.md` に従って書き、`shared/.claude/skills/<name>/SKILL.md`（正本）と
   各エージェントのミラー（`shared/.codex/skills/`・`shared/.openhands/skills/`・`shared/.gemini/skills/`、
   いずれも正本への symlink）の薄い skill ラッパーを添えると、各エージェントが該当タスクで自動発火できる
   （本体は常に `docs/` 側。SKILL.md はポインタのみ）。Gemini CLI は既定では AGENTS.md を読まないため、
   `shared/.gemini/settings.json`（`context.fileName` に AGENTS.md を指定）も配布する。
   consumer が Gemini 設定を固有化したくなったら、このファイルは shared/ から外す判断をする。
   OpenHands は V1 で `.openhands/skills/` を読むが **V0 は読まない**（かつ AGENTS.md も既定では読まない）。
   そこで、常時ロードされる repo microagent `shared/.openhands/microagents/repo.md` を配布する。中身は
   「作業前に AGENTS.md を読んで従え／詳細手順は `docs/` 参照」というポインタのみ（ルール本体は書かない）。
   AGENTS.md 側の常時層に各手順書の発火トリガ＋ポインタがテキストで入っているため、V0 でも
   AGENTS.md → `docs/<name>.md` の参照で手順書層をカバーできる（skill の自動発火は V1 で効く）。
3. **共通インフラ（実ファイル）** — 正本 `shared/` 配下に consumer のパスをミラー
   （例: `shared/.github/actions/publish-ci-logs/action.yml`）。同じ相対パスへ配置。
4. **リポジトリ横断タスク** — 正本 `tasks/<owner>/<repo>/*.md`。**その consumer だけ**の
   `.ai-ops/tasks/` へ配置。運用は `docs/cross-repo-tasks.md`。

2〜4 は `apply-shared.mjs` が配布し、配布済み一覧を consumer の **`.ai-ops/sync-manifest.txt`** に記録する。
**前回 manifest にあって今回の配布物に無いパスは削除**するので、shared/ での撤去・改名やタスク消化も
consumer へ伝播する（追加しかできない実装だと撤去がドリフトになる）。manifest 導入前から consumer に
ある unmanaged ファイルの撤去は `sync-deletions.txt`（トゥームストーン）に旧パスを列挙する。

## コンポーネント

| ファイル | 役割 |
|---|---|
| `AGENTS_COMMON.md` | （下り・ルール）共通ルール本体。ここだけ編集する |
| `scripts/apply-common.mjs` | （下り・ルール）consumer の AGENTS.md マーカー区間へ反映 |
| `shared/**` / `tasks/**` | （下り・ファイル）consumer へ配布する実ファイル・タスク |
| `scripts/apply-shared.mjs` | （下り・ファイル）shared/tasks の配置＋manifest 差分による削除伝播 |
| `sync-deletions.txt` | （下り）manifest 導入前の unmanaged ファイルを consumer から撤去する一覧 |
| `.github/workflows/sync.yml` | （下り）main の変更で各 consumer へ同期 PR を生成し、MERGE_MODE に応じてマージ |
| `consumers.txt` | 配布先リポジトリ（`owner/repo`） |
| `scripts/collect-outbox.mjs` | （上り）consumer の `.ai-ops/outbox/*.md` 提案を種別に応じて反映 |
| `.github/workflows/collect-outbox.yml` | （上り）cron（約6時間ごと）＋手動で起動、取り込み PR＋outbox 掃除 PR を生成 |

consumer 側に必要な配線は**無い**（workflow・Secret とも不要）。consumer を増やすときは
`consumers.txt` への追記と `OPS_SYNC_TOKEN`（PAT）のアクセス対象追加だけ。

## データフロー

### 下り（共通ルール／ファイル／タスクを変える・オーナー起点）

```
ai-ops: AGENTS_COMMON.md / shared/** / tasks/** を編集して main にマージ
   └─ sync.yml が各 consumer をチェックアウト
        ├─ apply-common.mjs: AGENTS.md のマーカー区間を更新
        └─ apply-shared.mjs: shared/** と tasks/<その consumer>/** を配置、
                             manifest 差分＋sync-deletions.txt のファイルを削除
   └─ 各 consumer に同期 PR（ブランチ ai-ops/sync-common）
        └─ MERGE_MODE=direct なら即マージ / auto なら auto-merge / off なら手動
```

### 上り（consumer 起点の提案・4種別）

```
consumer: エージェントが .ai-ops/outbox/<時刻>-<説明>.md を main に載せる
   └─ collect-outbox.yml（cron 約6時間ごと・手動可）が全 consumer を clone して最古の1件を処理
        ├─ common-block-edit : AGENTS_COMMON.md を全文置換（ベースハッシュで鮮度検査）
        ├─ shared-file       : shared/<対象パス> を置換
        ├─ task              : tasks/<対象リポジトリ>/ に登録
        └─ task-done         : tasks/<提案元>/<対象ファイル> を削除
   └─ ai-ops への取り込み PR ＋ 提案元への outbox 掃除 PR を生成
オーナーが取り込み PR をマージ → 下り（sync）に合流して配布
```

書式・鮮度検査（`ベース:`）の詳細は `docs/outbox-proposal.md`。

## トークン

| Secret | 置き場所 | 権限 | 用途 |
|---|---|---|---|
| `OPS_SYNC_TOKEN` | ai-ops のみ | ai-ops＋全 consumer / Contents:RW, PR:RW | 下り同期 PR・上り取り込み/掃除 PR の作成、consumer の読み取り |

> 以前は上りを即時にするため各 consumer に `OPS_DISPATCH_TOKEN`（ai-ops への Contents:RW）を置いて
> `repository_dispatch` していたが、「どの consumer からでもルールの正本に書けるトークン」が増殖する
> 設計だった（consumer が1つ侵害されると全リポジトリへルールを注入できる増幅経路）。ルール訂正に
> 即時性は不要なので cron ポーリングに変更し、consumer 側のトークン・workflow を全廃した。
> ai-ops の main にはブランチ保護を掛けておくこと（PAT による直 push の防止）。

## 前提・限界

- consumer の既定ブランチは `main` 前提（sync の base）。
- `shared/` 内の symlink は配布時に**実体化**される（`apply-shared.mjs` はファイル内容を読んでコピーする）。
  consumer には通常ファイルとして届くので、同一内容の二重配置（`.claude/skills/` と `.codex/skills/`）は
  ai-ops 側で symlink にしてドリフトを防ぐ。symlink の張り先が `shared/` の外だと CI の checkout に
  依存するため、**張り先も `shared/` 内に置くこと**。
- 初回、consumer に同等のインライン記述がある場合は、その consumer だけ初回手作業で
  「インライン削除＋マーカー挿入」を行う（以降はマーカーで置換され重複しない）。
- 上りの取り込みは**全文置換**なので、複数 doc にまたがる再構成には向かない。その場合は
  ai-ops のセッションで一括編集する（consumer からは `docs/outbox-proposal.md` の該当節参照）。
- collect は1回の実行で1件だけ処理する。後続提案は先行の cleanup PR マージ後に順次処理される。
- 提案・タスクの「なぜ」は frontmatter の `理由:` → 取り込み PR 本文 → ai-ops の PR/git 履歴に残る。
  consumer のエージェントから ai-ops の履歴は見えないため、**consumer 側でも将来参照しそうな判断根拠は
  配布 doc（`shared/docs/`）自体に書き込む**こと。
- エージェントごとに AGENTS.md への入口が違う。**正本は常に `AGENTS.md` 一本**にし、各エージェントを
  そこへ向ける（内容を各ファイルへ複製しない）:
  - Codex は `AGENTS.md` をネイティブに読む。
  - Claude Code は `CLAUDE.md` を読む。consumer 側で `CLAUDE.md -> AGENTS.md` symlink にすれば同じ AGENTS.md を読む。
  - Gemini CLI は既定 `GEMINI.md` だが、`shared/.gemini/settings.json` の `context.fileName: ["AGENTS.md"]`
    で AGENTS.md を読ませる（GEMINI.md はリストに入れない＝「GEMINI.md が無い」旨の探索メッセージも出ない）。
  - OpenHands は V0 だと AGENTS.md も `.openhands/skills/` も読まないため、常時ロードの
    `.openhands/microagents/repo.md`（ポインタ）から AGENTS.md へ誘導する。V1 は `.openhands/skills/` も読む。
  なお AGENTS.md を指す symlink（`GEMINI.md`/`CLAUDE.md` → `AGENTS.md`）は **`shared/` 経由で配れない**:
  `apply-shared.mjs` は symlink を実体化（内容コピー＝凍結）し、かつ AGENTS.md は consumer ごとにマーカー
  区間が異なる＆ `shared/` の外にあるため、配ると stale なコピーになる。symlink 方式を採るなら各リポジトリ
  直下での手当て（`CLAUDE.md` と同様）になる。Gemini を settings 方式にしているのはこのため。
