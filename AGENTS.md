# AGENTS.md — ai-ops

このリポジトリ **ai-ops** は、全リポジトリ（consumer）共通の **運用ルール**・**共通インフラ（ファイル）**・
**リポジトリ横断タスク**の**単一の正（source of truth）**。ここで1回直すと CI が各 consumer へ配布する。

**作業前に必ず [`shared/docs/OPS_SYNC_DESIGN.md`](shared/docs/OPS_SYNC_DESIGN.md) を読むこと。** 仕組みの全体像（下り＝配布／上り＝提案、
各ファイルの唯一の書き手、削除の伝播、トークン構成）が書いてある。運用手順は [`README.md`](README.md)。

## このリポジトリで変更するとき

- **共通ルール（エージェントの振る舞い）**を変える → `AGENTS_COMMON.md` を編集（ここだけが正本）。
- **共通インフラのファイル**（composite action・共有スクリプト等）を変える/足す → `shared/` 配下に
  **consumer のパスをミラーして**置く（例: `shared/.github/actions/<name>/action.yml`）。
- **`shared/` からファイルを撤去・改名する** → 消すだけでよい（manifest 差分で consumer からも消える）。
  manifest 導入前から consumer にあるファイルの撤去だけ `sync-deletions.txt` に旧パスを追記する。
- **別リポジトリに作業を依頼する** → `tasks/<owner>/<repo>/<時刻>-<説明>.md` を置く
  （書き方: [`shared/docs/cross-repo-tasks.md`](shared/docs/cross-repo-tasks.md)）。消化はファイル削除。
- **配布先を増やす** → `consumers.txt` に `owner/repo` を追記し、`OPS_SYNC_TOKEN`（PAT）のアクセス対象にも追加。
- consumer 側に配布済みのもの（AGENTS.md のマーカー区間・manifest 管理下のファイル）を
  **consumer 側で手編集しない**。直すときは必ず ai-ops 側で直す（consumer で直しても次回同期で上書きされる）。

## 何を ai-ops に入れるか（置き場所の振り分け）

> 「**これは共通か固有か**」という判断ルール自体は、各 consumer のエージェントが*作業中に*下すものなので、
> 共通ブロック（`AGENTS_COMMON.md` の「共通か固有かの判断」節）に置いて全 consumer へ配布している。
> ここ（ai-ops 内）には、**共通と判断したものを ai-ops の*どこに*置くか**だけを書く。

- **常時必要な振る舞いルール（テキスト）** → `AGENTS_COMMON.md`（各 AGENTS.md のマーカー区間へ埋め込み配布）。
  全タスクのコストに乗るので最小限に。
- **特定タスクでのみ必要な共通 doc（オンデマンド層）** → `shared/docs/<name>.md`（consumer では `docs/<name>.md`）。
  `AGENTS_COMMON.md` 側には「発火トリガ＋ポインタ」だけ残し、詳細手順はこちらへ逃がす。参照は **consumer パス
  `docs/<name>.md`** で書く（埋め込まれた先＝consumer で読まれるため）。例: `cross-repo-tasks.md` /
  `outbox-proposal.md` / `ci-logs.md`。手順系 doc（SOP）は書式規約 `shared/docs/sop-format.md` に従い、
  skill ラッパー `shared/.claude/skills/<name>/SKILL.md` を添える。各エージェント向けのミラー
  （`.codex` / `.openhands` / `.gemini` / `.agents`）は `apply-shared.mjs` が配布時に正本から自動生成する
  ので**置かない**（→ OPS_SYNC_DESIGN.md「配布物の三層＋タスク」）。
- **バイト一致であるべき実ファイル**（composite action・共有スクリプト等）→ `shared/` に consumer のパスをミラーして配置。
- **特定リポジトリ宛の作業依頼** → `tasks/<owner>/<repo>/`（共通化するものではなく、届けるもの）。

混同しない: 1番目は*埋め込む*もの、残りは*そのまま配置*するもの。配布スクリプトは埋め込み用
（`apply-common.mjs`）と配置用（`apply-shared.mjs`、`shared/**`・`tasks/**` の配布と削除の伝播）に分かれる。

> ai-ops 内では `docs/<name>.md` を `../shared/docs/<name>.md` への symlink にしておけば、ai-ops 自身の
> エージェントも consumer と同じパスで読める（`docs/OPS_SYNC_DESIGN.md` と同じ作法）。

## 完了手順

- 仕組み（スクリプト・workflow・配布対象）を変えたら、**`shared/docs/OPS_SYNC_DESIGN.md` と `README.md` の該当箇所も更新する**
  （設計と実装を乖離させない）。
- `consumers.txt` を変えたら PAT のアクセス対象も合わせる。

## 履歴ファイル

ai-ops での作業の「**なぜ**」（コードに無い制約・判断根拠）は **`docs/AI_TASK_HISTORY.md`** に追記する
（書き方・アーカイブは全リポジトリ共通規約 [`docs/task-history.md`](docs/task-history.md) に従う）。
consumer に影響する変更・ai-ops 内部だけの変更の区別なく、ここ1箇所でよい:
上り提案由来の変更は取り込み PR の本文（`理由:`）にも経緯が残り、consumer 側で将来参照しそうな判断根拠は
配布 doc（`shared/docs/`）自体に書き込むため（→ OPS_SYNC_DESIGN.md「前提・限界」）。

> **自動チェック**: `.claude/` の `Stop` フック（`check-history.sh`）が、追跡対象（`AGENTS_COMMON.md`・`shared/`・
> `tasks/`・`scripts/`・`.github/`・`AGENTS.md`・`.claude/` 等）を変更したセッションで、`docs/AI_TASK_HISTORY.md` に
> 触れず完了しようとすると**完了境界で1度 block して記録を促す**（`stop_hook_active` で1回だけ block）。
> ai-ops 固有設定で、consumer へは配布されない。
