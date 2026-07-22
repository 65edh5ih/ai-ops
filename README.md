# ai-ops

AIエージェント（Codex / Claude Code / Gemini CLI / Qwen Code / Kimi Code CLI / OpenHands / GitHub Copilot /
Continue / Cursor / Cline / Windsurf / Antigravity）向けの
**全リポジトリ共通の運用ルール・共通インフラ・
リポジトリ横断タスクの単一の正（source of truth）**。ここで1回直せば、CI が各 consumer リポジトリへ
同期PRを自動生成する（設定により自動マージまで）。手動リレー（外部ツールへのコピペ等）を不要にするのが目的。

- **設計の全体像（なぜこうなっているか）**: [`shared/docs/ops-sync-design.md`](shared/docs/ops-sync-design.md)（consumer では `docs/ops-sync-design.md` として配置）
- **このリポジトリで作業するエージェント向けの指示・置き場所の判断ルール**: [`AGENTS.md`](AGENTS.md)
- 以下は運用手順（how）。

## なぜ「同期（コピーを各リポジトリに置く）」なのか

エージェントは原則1セッション1リポジトリしか見えず、兄弟リポジトリのメモリ（AGENTS.md/CLAUDE.md）は
自動ロードされない（例外は [`shared/docs/ops-sync-design.md`](shared/docs/ops-sync-design.md)
「前提・限界」のマルチリポジトリセッションの項）。
したがって「全リポジトリの AI に同じ共通ルールを確実に効かせる」唯一堅牢な方法は、
**共通ルールを各リポジトリの AGENTS.md に物理的に存在させる**こと。その配布を自動化するのが本リポジトリ。

エージェントごとに入口ファイルが違う（Codex=`AGENTS.md`、Claude Code=`CLAUDE.md`、Gemini CLI=`GEMINI.md`、
Qwen Code=`QWEN.md`）が、`CLAUDE.md` / `GEMINI.md` / `QWEN.md` を `AGENTS.md` への symlink にすれば
**全エージェントが同じ AGENTS.md を読む**。この入口 symlink は sync が各 consumer に自動配線する
（`scripts/apply-entrypoints.mjs`）ので、正本はプレーンな `AGENTS.md` 一本でよい（plugin / hook に依存しない
＝エージェント非依存）。OpenHands V0 だけは AGENTS.md を既定で読まないため、
`shared/.openhands/microagents/repo.md`（AGENTS.md へのポインタ）で誘導する。GitHub Copilot
（`.github/copilot-instructions.md`）・Continue（`.continue/rules/ai-ops.md`）・Cursor（`.cursor/rules/ai-ops.mdc`）・
Cline（`.clinerules/ai-ops.md`）・Windsurf（`.windsurf/rules/ai-ops.md`）も同様に、`shared/` 配布の固定内容
ポインタから AGENTS.md へ誘導する（入口が実ファイルなので symlink 配線は不要）。Codex / Kimi Code CLI /
Antigravity は `AGENTS.md` をネイティブに読む（Antigravity・Qwen Code は `GEMINI.md` / `QWEN.md` 入口 symlink も
拾う）ため、**追加配線なしで対応済み**（詳細は `shared/docs/ops-sync-design.md`「前提・限界」のエージェント別入口一覧）。

## 構成

| ファイル | 役割 |
|---|---|
| `AGENTS.md` | ai-ops で作業するエージェント向けの指示・置き場所の判断ルール |
| `shared/docs/ops-sync-design.md` | 仕組みの設計ドキュメント（アーキテクチャ・判断根拠） |
| `AGENTS_COMMON.md` | 共通ルール本体（**ここだけを編集する**） |
| `shared/**` | （下り）consumer へ配布する実ファイル・共通 doc。consumer のパスをミラー |
| `tasks/<owner>/<repo>/` | （下り）その consumer 宛のリポジトリ横断タスク（→ `shared/docs/cross-repo-tasks.md`） |
| `sync-deletions.txt` | （下り）consumer から撤去する unmanaged ファイルの一覧 |
| `consumers.txt` | 配布先リポジトリ（`owner/repo` を1行ずつ） |
| `scripts/apply-common.mjs` | （下り）consumer の AGENTS.md のマーカー区間へ反映（無ければ追記） |
| `scripts/apply-entrypoints.mjs` | （下り）consumer に `CLAUDE.md` / `GEMINI.md` → `AGENTS.md` の入口 symlink を配線 |
| `scripts/apply-shared.mjs` | （下り）`shared/**`・`tasks/**` の配置（正本の実行ビットを保持）と、manifest 差分による削除の伝播、skill ミラーの自動生成 |
| `.github/workflows/sync.yml` | （下り）変更時＋cron（1日1回の再適用＝手編集ドリフトの自己修復）で各 consumer へ同期PRを自動生成（MERGE_MODE で自動マージ可） |
| `scripts/collect-outbox.mjs` | （上り）consumer の `.ai-ops/outbox/*.md` 提案を種別に応じて反映（1 consumer 分をまとめて処理・不正な提案は `rejected/` へ差し戻し） |
| `.github/workflows/collect-outbox.yml` | （上り）cron（約6時間ごと）＋手動で提案を拾い、取り込みPR＋掃除PRを生成。あわせてトゥームストーン掃除 |
| `scripts/archive-task-history.mjs` | （保守）`docs/history-inbox/` のフラグメントを本体へ統合し、保持量超過分を `docs/history-archive/` へ移す |
| `.github/workflows/archive-task-history.yml` | （保守）cron（1日1回）で ai-ops＋全 consumer を巡回し、未統合フラグメント／超過分の統合＋アーカイブPRを生成・マージ |
| `scripts/prune-tombstones.mjs` | （保守）`sync-deletions.txt` の役目を終えた行（全 consumer で削除済み）を自動で刈る |

## セットアップ（1回だけ）

1. fine-grained PAT を発行（対象: ai-ops と全 consumer / 権限: **Contents: RW**, **Pull requests: RW**）。
2. 本リポジトリの Actions Secret に **`OPS_SYNC_TOKEN`** として登録。
3. ai-ops の `main` にブランチ保護を掛ける（PAT による直 push の防止）。
4. `AGENTS_COMMON.md` を main に置く（初回 push で workflow が走り、各 consumer へ配線PRが立つ）。

consumer 側のセットアップは**不要**（workflow・Secret とも置かない）。

## 運用

- **共通ルールを変える（オーナー起点）**: `AGENTS_COMMON.md` を編集して main にマージするだけ。
- **手順系 doc（SOP）を書く・直す**: 書式は `shared/docs/sop-format.md`（consumer では `docs/sop-format.md`。
  リポジトリ固有の手順 doc にも適用される）。共通 SOP には `shared/.claude/skills/<name>/SKILL.md` の skill
  ラッパーを添えると、Claude Code / Codex / OpenHands（V1）/ Gemini CLI / Qwen Code / Antigravity が
  自動発火できる（各エージェント向けミラー `.codex` / `.openhands` / `.gemini` / `.agents`〔Antigravity〕/
  `.qwen`〔Qwen Code〕は apply-shared が配布時に自動生成する。ai-ops に置くのは正本1ファイルだけ）。
  OpenHands V0 は skill を読まないため、
  常時ロードの `shared/.openhands/microagents/repo.md`（AGENTS.md へのポインタ）経由で、AGENTS.md →
  `docs/<name>.md` を辿らせる（詳細は `shared/docs/ops-sync-design.md`「前提・限界」）。
- **共通ファイル・doc を変える**: `shared/` 配下を編集して main にマージ。**撤去・改名したときは**
  旧パスが manifest 管理下なら自動で消える。manifest 導入前から consumer にあるファイルは
  `sync-deletions.txt` に旧パスを追記する（役目を終えた行は collect の保守バッチが自動で刈る）。
- **別リポジトリに作業を依頼する**: `tasks/<owner>/<repo>/<時刻>-<説明>.md` を main に載せる
  （consumer 起点なら outbox の `種別: task`）。詳細は `shared/docs/cross-repo-tasks.md`。
- **consumer を増やす**: `consumers.txt` に追記し、PAT のアクセス対象にもそのリポジトリを追加する。
- **タスク履歴の統合・アーカイブ**: 自動。エージェントは履歴を本体に直接書かず、1エントリ＝1ファイルで
  `docs/history-inbox/`（→ `shared/docs/task-history.md`）に置く（並行 PR のコンフリクト回避）。
  *Archive task histories* workflow（cron 1日1回）が ai-ops と全 consumer を巡回し、フラグメントを
  `docs/AI_TASK_HISTORY.md` へ統合＋保持量（直近2作業日分）超過分をアーカイブする PR を自動マージする。
  急ぐときは workflow を手動実行する。`docs/history-inbox/` は配布された `README.md` プレースホルダ
  （正本 `shared/docs/history-inbox/README.md`）で常設し、全フラグメント統合後もディレクトリが消えないようにする。
- **同期PRのマージ**: `sync.yml` の `MERGE_MODE` で選ぶ。`direct`（即マージ・完全自動）/
  `auto`（GitHub auto-merge。consumer に branch protection＋required checks が必要）/ `off`（手動）。
  現在は `direct`（内容レビューは ai-ops のマージ時に済んでいる、という設計）。
- **ドリフトの自己修復**: sync は main の変更時に加えて cron（1日1回）でも全 consumer へ再適用する。
  consumer 側でマーカー区間や配布ファイルが手編集されても、翌日までに同期PRで正本へ戻る
  （差分が無ければ何も起きない）。

### 上り（consumer 起点で共通ルール・ファイルを直す／作業を依頼する）

consumer での作業中に AI エージェントが気づいたことは、作業リポジトリの `.ai-ops/outbox/` に
提案ファイルとして置くだけでよい（書式: `shared/docs/outbox-proposal.md`。consumer では
`docs/outbox-proposal.md`）。ai-ops の collect workflow（cron 約6時間ごと）が拾い、
**取り込み PR**（ai-ops 側。同一リポジトリの提案はまとめて1本、`common-block-edit` には
常時層サイズの増減を自動記載）と **outbox 掃除 PR**（consumer 側）を自動生成する。
不正な提案は取り込まれず `.ai-ops/outbox/rejected/` へエラーノート付きで差し戻される
（後続の提案は止まらない）。オーナーが取り込み PR をマージすると全 consumer へ配布される。
急ぐときは ai-ops の *Collect outbox proposals* workflow を手動実行する。

## 前提・限界

`shared/docs/ops-sync-design.md` の「前提・限界」を参照（consumer の既定ブランチは `main` 前提、
初回のインライン重複は手作業、上りは全文置換＝ベースハッシュで鮮度検査、collect は1回に
1 consumer 分＝衝突する提案は次回、など）。
