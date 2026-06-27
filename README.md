# ai-ops

AIエージェント（Codex / Claude Code）向けの **全リポジトリ共通の運用ルールの単一の正（source of truth）**。
ここで1回直せば、CI が各 consumer リポジトリへ同期PRを自動生成する。手動リレー（Notion等）を不要にするのが目的。

## なぜ「同期（コピーを各リポジトリに置く）」なのか

エージェントは1セッション1リポジトリしか見えず（Claude Code on the web のクラウドセッションはマルチリポジトリ非対応）、
複数ディレクトリを足しても兄弟リポジトリのメモリ（AGENTS.md/CLAUDE.md）は自動ロードされない。
したがって「全リポジトリの AI に同じ共通ルールを確実に効かせる」唯一堅牢な方法は、
**共通ルールを各リポジトリの AGENTS.md に物理的に存在させる**こと。その配布を自動化するのが本リポジトリ。

Codex は `AGENTS.md`、Claude Code は `CLAUDE.md` を読むが、consumer 側で `CLAUDE.md -> AGENTS.md` の
symlink にしておけば**両エージェントが同じ AGENTS.md を読む**ため、配布対象はプレーンな `AGENTS.md` だけでよい
（plugin / hook に依存しない＝エージェント非依存）。

## 構成

| ファイル | 役割 |
|---|---|
| `AGENTS_COMMON.md` | 共通ルール本体（**ここだけを編集する**） |
| `consumers.txt` | 配布先リポジトリ（`owner/repo` を1行ずつ） |
| `scripts/apply-common.mjs` | consumer の AGENTS.md のマーカー区間へ反映（無ければ追記） |
| `.github/workflows/sync.yml` | 変更時に各 consumer へ同期PRを自動生成 |

## セットアップ（1回だけ）

1. fine-grained PAT を発行（対象: ai-ops と全 consumer / 権限: **Contents: RW**, **Pull requests: RW**）。
2. 本リポジトリの Actions Secret に **`OPS_SYNC_TOKEN`** として登録。
3. `AGENTS_COMMON.md` を main に置く（初回 push で workflow が走り、各 consumer へ配線PRが立つ）。

## 運用

- 共通ルールを変えたいとき: **`AGENTS_COMMON.md` を編集して main にマージするだけ**。各 consumer に同期PRが自動で立つ。
- consumer を増やすとき: `consumers.txt` に追記し、PAT のアクセス対象にもそのリポジトリを追加する。
- consumer 側の `AGENTS.md` は「共通ブロック（`AI-OPS:COMMON` マーカー囲み・**手で触らない**）＋リポジトリ固有」に分ける。

## 前提・限界

- consumer の既定ブランチは `main` 前提（workflow の base）。違う場合は調整する。
- 初回、consumer に既に同等の記述がインラインである場合は、配線PRが重複を生むため、**その consumer は初回だけ手で
  「該当インライン記述の削除＋マーカー挿入」**を行う（以降はマーカーがあるので置換され重複しない）。
- shared な docs（例: 目視確認手順）の配布は将来拡張（v1）。現状は AGENTS.md の共通ブロックのみ同期する。
