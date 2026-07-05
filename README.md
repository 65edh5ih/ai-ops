# ai-ops

AIエージェント（Codex / Claude Code）向けの **全リポジトリ共通の運用ルール・共通インフラ・
リポジトリ横断タスクの単一の正（source of truth）**。ここで1回直せば、CI が各 consumer リポジトリへ
同期PRを自動生成する（設定により自動マージまで）。手動リレー（外部ツールへのコピペ等）を不要にするのが目的。

- **設計の全体像（なぜこうなっているか）**: [`shared/docs/OPS_SYNC_DESIGN.md`](shared/docs/OPS_SYNC_DESIGN.md)（consumer では `docs/OPS_SYNC_DESIGN.md` として配置）
- **このリポジトリで作業するエージェント向けの指示・置き場所の判断ルール**: [`AGENTS.md`](AGENTS.md)
- 以下は運用手順（how）。

## なぜ「同期（コピーを各リポジトリに置く）」なのか

エージェントは1セッション1リポジトリしか見えず、兄弟リポジトリのメモリ（AGENTS.md/CLAUDE.md）は
自動ロードされない。したがって「全リポジトリの AI に同じ共通ルールを確実に効かせる」唯一堅牢な方法は、
**共通ルールを各リポジトリの AGENTS.md に物理的に存在させる**こと。その配布を自動化するのが本リポジトリ。

Codex は `AGENTS.md`、Claude Code は `CLAUDE.md` を読むが、consumer 側で `CLAUDE.md -> AGENTS.md` の
symlink にしておけば**両エージェントが同じ AGENTS.md を読む**ため、配布対象はプレーンな `AGENTS.md` だけでよい
（plugin / hook に依存しない＝エージェント非依存）。

## 構成

| ファイル | 役割 |
|---|---|
| `AGENTS.md` | ai-ops で作業するエージェント向けの指示・置き場所の判断ルール |
| `shared/docs/OPS_SYNC_DESIGN.md` | 仕組みの設計ドキュメント（アーキテクチャ・判断根拠） |
| `AGENTS_COMMON.md` | 共通ルール本体（**ここだけを編集する**） |
| `shared/**` | （下り）consumer へ配布する実ファイル・共通 doc。consumer のパスをミラー |
| `tasks/<owner>/<repo>/` | （下り）その consumer 宛のリポジトリ横断タスク（→ `shared/docs/cross-repo-tasks.md`） |
| `sync-deletions.txt` | （下り）consumer から撤去する unmanaged ファイルの一覧 |
| `consumers.txt` | 配布先リポジトリ（`owner/repo` を1行ずつ） |
| `scripts/apply-common.mjs` | （下り）consumer の AGENTS.md のマーカー区間へ反映（無ければ追記） |
| `scripts/apply-shared.mjs` | （下り）`shared/**`・`tasks/**` の配置と、manifest 差分による削除の伝播 |
| `.github/workflows/sync.yml` | （下り）変更時に各 consumer へ同期PRを自動生成（MERGE_MODE で自動マージ可） |
| `scripts/collect-outbox.mjs` | （上り）consumer の `.ai-ops/outbox/*.md` 提案を種別に応じて反映 |
| `.github/workflows/collect-outbox.yml` | （上り）cron（約6時間ごと）＋手動で提案を拾い、取り込みPR＋掃除PRを生成 |

## セットアップ（1回だけ）

1. fine-grained PAT を発行（対象: ai-ops と全 consumer / 権限: **Contents: RW**, **Pull requests: RW**）。
2. 本リポジトリの Actions Secret に **`OPS_SYNC_TOKEN`** として登録。
3. ai-ops の `main` にブランチ保護を掛ける（PAT による直 push の防止）。
4. `AGENTS_COMMON.md` を main に置く（初回 push で workflow が走り、各 consumer へ配線PRが立つ）。

consumer 側のセットアップは**不要**（workflow・Secret とも置かない）。

## 運用

- **共通ルールを変える（オーナー起点）**: `AGENTS_COMMON.md` を編集して main にマージするだけ。
- **手順系 doc（SOP）を書く・直す**: 書式は `shared/docs/sop-format.md`（consumer では `docs/sop-format.md`。
  リポジトリ固有の手順 doc にも適用される）。共通 SOP には `shared/.claude/skills/<name>/SKILL.md`（正本）＋
  `shared/.codex/skills/<name>/SKILL.md`（symlink）の skill ラッパーを添えると Claude Code / Codex が自動発火できる。
- **共通ファイル・doc を変える**: `shared/` 配下を編集して main にマージ。**撤去・改名したときは**
  旧パスが manifest 管理下なら自動で消える。manifest 導入前から consumer にあるファイルは
  `sync-deletions.txt` に旧パスを追記する。
- **別リポジトリに作業を依頼する**: `tasks/<owner>/<repo>/<時刻>-<説明>.md` を main に載せる
  （consumer 起点なら outbox の `種別: task`）。詳細は `shared/docs/cross-repo-tasks.md`。
- **consumer を増やす**: `consumers.txt` に追記し、PAT のアクセス対象にもそのリポジトリを追加する。
- **同期PRのマージ**: `sync.yml` の `MERGE_MODE` で選ぶ。`direct`（即マージ・完全自動）/
  `auto`（GitHub auto-merge。consumer に branch protection＋required checks が必要）/ `off`（手動）。
  現在は `auto`。内容レビューは ai-ops のマージ時に済んでいる、という設計なので `direct` にしてよい。

### 上り（consumer 起点で共通ルール・ファイルを直す／作業を依頼する）

consumer での作業中に AI エージェントが気づいたことは、作業リポジトリの `.ai-ops/outbox/` に
提案ファイルとして置くだけでよい（書式: `shared/docs/outbox-proposal.md`。consumer では
`docs/outbox-proposal.md`）。ai-ops の collect workflow（cron 約6時間ごと）が拾い、
**取り込み PR**（ai-ops 側）と **outbox 掃除 PR**（consumer 側）を自動生成する。
オーナーが取り込み PR をマージすると全 consumer へ配布される。急ぐときは
ai-ops の *Collect outbox proposals* workflow を手動実行する。

## 前提・限界

`shared/docs/OPS_SYNC_DESIGN.md` の「前提・限界」を参照（consumer の既定ブランチは `main` 前提、
初回のインライン重複は手作業、上りは全文置換＝ベースハッシュで鮮度検査、collect は1回1件、など）。
