# AGENTS.md — ai-ops

このリポジトリ **ai-ops** は、全リポジトリ（consumer）共通の **運用ルール**と**共通インフラ（ファイル）** の
**単一の正（source of truth）**。ここで1回直すと CI が各 consumer へ配布する。

**作業前に必ず [`shared/docs/DESIGN.md`](shared/docs/DESIGN.md) を読むこと。** 仕組みの全体像（下り＝配布／上り＝提案、
各ファイルの唯一の書き手、トークン構成）が書いてある。運用手順は [`README.md`](README.md)。

## このリポジトリで変更するとき

- **共通ルール（エージェントの振る舞い）**を変える → `AGENTS_COMMON.md` を編集（ここだけが正本）。
- **共通インフラのファイル**（composite action・共有スクリプト等）を変える/足す → `shared/` 配下に
  **consumer のパスをミラーして**置く（例: `shared/.github/actions/<name>/action.yml`）。
- **配布先を増やす** → `consumers.txt` に `owner/repo` を追記し、`OPS_SYNC_TOKEN`（PAT）のアクセス対象にも追加。
- consumer 側に配布済みのもの（AGENTS.md のマーカー区間・`shared/` 由来ファイル）を **consumer 側で手編集しない**。
  直すときは必ず ai-ops 側で直す（consumer で直しても次回同期で上書きされる）。

## 何を ai-ops に入れるか（置き場所の振り分け）

> 「**これは共通か固有か**」という判断ルール自体は、各 consumer のエージェントが*作業中に*下すものなので、
> 共通ブロック（`AGENTS_COMMON.md` の「共通か固有かの判断」節）に置いて全 consumer へ配布している。
> ここ（ai-ops 内）には、**共通と判断したものを ai-ops の*どこに*置くか**だけを書く。

共通と判断されたものが ai-ops に来たら、2種類に振り分ける:

- **振る舞いルール（テキスト）** → `AGENTS_COMMON.md`（各 AGENTS.md のマーカー区間へ埋め込み配布）。
- **バイト一致であるべき実ファイル**（composite action・共有スクリプト等）→ `shared/` に consumer のパスをミラーして配置。

混同しない: 前者は*埋め込む*もの、後者は*そのまま配置*するもの。配布スクリプトも別
（`apply-common.mjs` / `apply-shared.mjs`）。

## 完了手順

- 仕組み（スクリプト・workflow・配布対象）を変えたら、**`shared/docs/DESIGN.md` と `README.md` の該当箇所も更新する**
  （設計と実装を乖離させない）。
- `consumers.txt` を変えたら PAT のアクセス対象も合わせる。

## 履歴ファイル

ai-ops は共通基盤そのものなので、ここでの作業は**ほとんどが consumer に影響する＝本体は Notion**
「AI Cross-Repo Task Log」に記録する。`docs/history.md` は**例外的に**使う。

- **共通基盤に関わる変更**（`AGENTS_COMMON.md`・`shared/` 配下・consumer 全体に影響するもの）＝通常ケース
  → Notion「AI Cross-Repo Task Log」に「なぜ」を記録。
- **ai-ops にのみ関わる変更**（collect/sync スクリプト・ai-ops 自身の workflow・`.claude/` の開発ツール等、
  consumer に届かない内部変更）＝例外ケース → `docs/history.md` に追記（新しいエントリを先頭に）。
- 判断基準: 「consumer の手元に影響が届くか」。届くなら Notion、届かないなら history.md。

> **自動チェック**: `.claude/` の `Stop` フック（`check-history.sh`）が、追跡対象（`AGENTS_COMMON.md`・`shared/`・
> `scripts/`・`.github/`・`AGENTS.md`・`.claude/` 等）を変更したセッションで、履歴記録に触れず完了しようとすると
> **完了境界で1度 block して記録を促す**。Notion 書き込みは外部で検証できないため、フックは*忘却の防止*であって
> 記録の保証ではない（`stop_hook_active` で1回だけ block。`docs/history.md` を更新していれば即通す）。
> ai-ops 固有設定で、consumer へは配布されない。
