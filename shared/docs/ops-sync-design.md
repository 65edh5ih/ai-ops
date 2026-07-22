# ai-ops 設計ドキュメント

全リポジトリ（consumer）共通の **運用ルール**・**共通インフラ（ファイル）**・**リポジトリ横断タスク**を、
ここ ai-ops を単一の正（source of truth）として各 consumer へ自動配布するための仕組み。手動リレー
（外部ツールへのコピペ等）を不要にし、リポジトリ間のドリフトを構造的に防ぐのが目的。

> **ai-ops 内での正本パス**: `shared/docs/ops-sync-design.md`（`apply-shared.mjs` により各 consumer へ `docs/ops-sync-design.md` として配布）。

## 解決したい問題

- 複数リポジトリ（nikki-san / private …）で AI エージェントに**同じ共通ルールを確実に効かせたい**。
- だが各エージェントのセッションは**原則 1 セッション 1 リポジトリ**で、兄弟リポジトリのメモリ
  （AGENTS.md / CLAUDE.md）は自動ロードされない（例外は「前提・限界」のマルチリポジトリセッションの項。
  設計の前提は変わらない）。→ 唯一堅牢な方法は、**共通ルールを各リポジトリの
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
| 各リポジトリの `docs/history-inbox/<...>.md`（履歴フラグメント） | 新規1ファイル＝そのリポジトリのエージェント（既存ファイルには触れない） |
| 各リポジトリの `docs/AI_TASK_HISTORY.md` | inbox の統合・アーカイブ移動とも ai-ops の archive CI（下記・保守バッチ）。エージェントは直接編集しない |

## 配布物の三層＋タスク

1. **常時必要な共通ルール（テキスト）** — 正本 `AGENTS_COMMON.md`。`apply-common.mjs` が各 consumer の
   `AGENTS.md` の `AI-OPS:COMMON` マーカー区間に**埋め込む**（マーカーが無ければ末尾に追記＝初回配線）。
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
   以前は ai-ops 側に正本への symlink を1エージェントぶんずつ手で置いていたが、完全に機械的な複製で
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
| `scripts/apply-entrypoints.mjs` | （下り・配線）consumer に `CLAUDE.md` / `GEMINI.md` → `AGENTS.md` の入口 symlink を張る |
| `shared/**` / `tasks/**` | （下り・ファイル）consumer へ配布する実ファイル・タスク |
| `scripts/apply-shared.mjs` | （下り・ファイル）shared/tasks の配置（実行ビット保持）＋manifest 差分による削除伝播＋skill ミラーの自動生成 |
| `sync-deletions.txt` | （下り）manifest 導入前の unmanaged ファイルを consumer から撤去する一覧 |
| `.github/workflows/sync.yml` | （下り）main の変更＋cron（1日1回の再適用＝手編集ドリフトの自己修復）で各 consumer へ同期 PR を生成し、MERGE_MODE に応じてマージ |
| `consumers.txt` | 配布先リポジトリ（`owner/repo`） |
| `scripts/collect-outbox.mjs` | （上り）consumer の `.ai-ops/outbox/*.md` 提案を種別に応じて反映（1 consumer 分をまとめて処理・不正な提案は `rejected/` へ差し戻し） |
| `.github/workflows/collect-outbox.yml` | （上り）cron（約6時間ごと）＋手動で起動、取り込み PR＋outbox 掃除 PR を生成。あわせてトゥームストーン掃除（保守） |
| `scripts/archive-task-history.mjs` | （保守）`docs/history-inbox/` のフラグメントを `docs/AI_TASK_HISTORY.md` へ統合し、保持量超過分を `docs/history-archive/` へ移す |
| `.github/workflows/archive-task-history.yml` | （保守）cron（1日1回）で ai-ops＋全 consumer を巡回し、未統合フラグメントか超過エントリがあれば統合＋アーカイブ PR を生成・マージ |
| `scripts/prune-tombstones.mjs` | （保守）`sync-deletions.txt` の役目を終えた行（全 consumer から対象が消えた）を刈る |

consumer 側に必要な配線は**無い**（workflow・Secret とも不要）。consumer を増やすときは
`consumers.txt` への追記と `OPS_SYNC_TOKEN`（PAT）のアクセス対象追加だけ。

## データフロー

### 下り（共通ルール／ファイル／タスクを変える・オーナー起点）

```
ai-ops: AGENTS_COMMON.md / shared/** / tasks/** を編集して main にマージ
        （＋cron 1日1回の再適用: consumer 側で手編集されたドリフトを翌日までに自己修復）
   └─ sync.yml が各 consumer をチェックアウト
        ├─ apply-common.mjs: AGENTS.md のマーカー区間を更新
        ├─ apply-entrypoints.mjs: CLAUDE.md / GEMINI.md → AGENTS.md の入口 symlink を張る
        └─ apply-shared.mjs: shared/** と tasks/<その consumer>/** を配置
                             （skill ミラーは正本 .claude/skills/ から自動生成）、
                             manifest 差分＋sync-deletions.txt のファイルを削除
   └─ 各 consumer に同期 PR（ブランチ ai-ops/sync-common）
        └─ MERGE_MODE=direct なら即マージ / auto なら auto-merge / off なら手動
```

### 上り（consumer 起点の提案・4種別）

```
consumer: エージェントが .ai-ops/outbox/<時刻>-<説明>.md を main に載せる
   └─ collect-outbox.yml（cron 約6時間ごと・手動可）が全 consumer を clone し、
      最古の提案を持つ consumer の提案をまとめて処理
        ├─ common-block-edit : AGENTS_COMMON.md を全文置換（ベースハッシュで鮮度検査・
        │                      常時層サイズの増減を取り込み PR に記載）
        ├─ shared-file       : shared/<対象パス> を置換
        ├─ task              : tasks/<対象リポジトリ>/ に登録
        ├─ task-done         : tasks/<提案元>/<対象ファイル> を削除
        └─ 不正な提案        : .ai-ops/outbox/rejected/ へエラーノート付きで差し戻し
                               （最古に居座って後続を止めない）
   └─ ai-ops への取り込み PR（まとめて1本）＋ 提案元への outbox 掃除 PR を生成
オーナーが取り込み PR をマージ → 下り（sync）に合流して配布
```

書式・鮮度検査（`ベース:`）の詳細は `docs/outbox-proposal.md`。

### 保守バッチ（決定的な定型作業はエージェントにやらせない）

移動・削除・複製のような**完全に決定的で判断要素の無い作業**は、エージェントのセッション
（＝LLM のトークン）でやらせず、cron の集中バッチが行う。現行の保守バッチ:

- **タスク履歴のアーカイブ**（下記）
- **トゥームストーン掃除**: `sync-deletions.txt` の行のうち、全 consumer の main から対象ファイルが
  消えたものを自動で刈る（`prune-tombstones.mjs`。collect-outbox.yml に同居して、その実行が clone した
  全 consumer をそのまま判定に使う。機械的削除なので PR は自動マージ）。
- **skill ミラーの自動生成**・**sync の cron 再適用**は保守バッチというより下りの一部（上記）。

#### タスク履歴の統合とアーカイブ

エージェントは履歴を `docs/AI_TASK_HISTORY.md` へ直接追記せず、**1エントリ＝1ファイル**で
`docs/history-inbox/<YYYY-MM-DD>-<スラッグ>.md` に置く（→ `docs/task-history.md`）。全セッションが本体の
先頭行に挿入すると並行 PR が必ずコンフリクトするため、書き込みを別々のパスに散らして衝突を無くす
（changelog の towncrier 型フラグメント）。読む側は本体＋`history-inbox/` の両方を見る。

`archive-task-history.yml`（cron 1日1回）が ai-ops＋全 consumer を巡回し、`archive-task-history.mjs` が
(1) `history-inbox/` のフラグメントを本体へ取り込んでフラグメントを削除（consolidate）、(2) 取り込み後の
保持量超過分を `docs/history-archive/<YYYY>.md` へ移す（archive）。統合すべきフラグメントか超過エントリが
あるリポジトリにだけ PR を生成・マージする。

`docs/history-inbox/` は**配布された `README.md` プレースホルダ**（正本 `shared/docs/history-inbox/README.md`・
apply-shared が全 consumer へ配布）で常に空でない状態に保つ: 全フラグメントを統合するとディレクトリが
空になり、git は空ディレクトリを追跡しないため、これが無いと fresh checkout で「書き込み先」ディレクトリごと
消える。バッチはこの `README.md` を取り込み対象から除外する（`docs/task-history.md` にも明記）。

- **エージェントのセッションでやらない**（統合・アーカイブとも）: 移動は完全に決定的で判断要素が無く、
  LLM（特に軽量モデル）にやらせるとトークンを浪費するうえ大きなファイル編集を壊しやすい（実際に力尽きる事例があった）。
- **consumer 側の push 駆動 workflow にしない**: 即時性は上がるが、「consumer 側に workflow・Secret を
  置かない」原則（上記）を破り、workflow ファイルの配布に PAT の Workflows 権限（＝全 consumer の
  CI を書き換えられる権限）も要る。保持量はソフト目標なので1日1回の集中巡回で足りる。

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
  `.claude/skills/` から自動生成するので、ai-ops 側に二重配置（symlink 含む）を置かない。それ以外で
  同一内容を複数パスに配りたい場合は ai-ops 側で symlink にしてドリフトを防ぐ。symlink の張り先が
  `shared/` の外だと CI の checkout に依存するため、**張り先も `shared/` 内に置くこと**。
- 初回、consumer に同等のインライン記述がある場合は、その consumer だけ初回手作業で
  「インライン削除＋マーカー挿入」を行う（以降はマーカーで置換され重複しない）。
- 上りの取り込みは**全文置換**なので、複数 doc にまたがる再構成には向かない。その場合は
  ai-ops のセッションで一括編集する（consumer からは `docs/outbox-proposal.md` の該当節参照）。
- collect は1回の実行で、最古の提案を持つ consumer の分をまとめて処理する。別 consumer の提案と、
  同一実行内で衝突する提案（2件目以降の common-block-edit・対象パスが重複する shared-file）は、
  先行の cleanup PR マージ後の実行で処理される。不正な提案は `.ai-ops/outbox/rejected/` へ
  エラーノート付きで差し戻されるため、キューに残って後続を止めることはない。
- 提案・タスクの「なぜ」は frontmatter の `理由:` → 取り込み PR 本文 → ai-ops の PR/git 履歴に残る。
  consumer のエージェントから ai-ops の履歴は見えないため、**consumer 側でも将来参照しそうな判断根拠は
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
    その固定内容ポインタから AGENTS.md へ誘導する（`shared/.continue/rules/ai-ops.md`）。
  - Cursor は `.cursor/rules/*.mdc`（frontmatter `alwaysApply: true` で常時適用）を読む →
    その固定内容ポインタから AGENTS.md へ誘導する（`shared/.cursor/rules/ai-ops.mdc`）。
  - Cline は `.clinerules/`（ディレクトリ配下の Markdown を常時ロード）を読む →
    その固定内容ポインタから AGENTS.md へ誘導する（`shared/.clinerules/ai-ops.md`）。加えて Cline は
    skill（`.cline/skills/<name>/SKILL.md`）を description マッチで自動発火する（v3.48〜。progressive
    loading）ので、他エージェントと同じく `.claude/skills/` を正本とするミラーを `.cline/skills/` にも配る
    （`apply-shared.mjs` の `SKILL_MIRROR_ROOTS`）。＝常時ルールは `.clinerules/` ポインタ、SOP は
    `.cline/skills/` ミラーの二本立て（Gemini / Qwen と同じ構成）。
  - Windsurf は `.windsurf/rules/*.md`（frontmatter `trigger: always_on` で常時適用。1行目から frontmatter）を
    読む → その固定内容ポインタから AGENTS.md へ誘導する（`shared/.windsurf/rules/ai-ops.md`）。
  Copilot / Continue / Cursor / Cline / Windsurf は入口（＝常時ルール層）が**固定内容の実ファイル**（consumer
  非依存・`shared/` の中に置ける）なので、`CLAUDE.md`/`GEMINI.md` のような入口 symlink（`apply-entrypoints.mjs`）
  ではなく `apply-shared.mjs` の通常配布で届く。このうち **Cline だけは skill の自動発火機構を持つ**（上記
  `.cline/skills/`）ので手順書層も skill ミラーで拾える。残り（Copilot / Continue / Cursor / Windsurf）は skill
  自動発火機構が無いため、手順書層は OpenHands V0 と同じく AGENTS.md 常時層のトリガ → `docs/<name>.md` 参照で
  カバーする（ポインタには本体を書かない）。
  `GEMINI.md`/`CLAUDE.md` → `AGENTS.md` の入口 symlink は **`shared/` 経由で配れない**（`apply-shared.mjs` は
  symlink を実体化＝凍結し、かつ AGENTS.md は consumer ごとにマーカー区間が異なる＆ `shared/` の外）。
  そこで **`apply-entrypoints.mjs`** が各 consumer の checkout 内に直接 symlink を張る（sync.yml の1ステップ。
  冪等・既存の実体ファイルは壊さない）。ai-ops 自身の repo 直下にも `CLAUDE.md`/`GEMINI.md -> AGENTS.md` を置く。
