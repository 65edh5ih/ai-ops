# リポジトリ運用ルール（Cline 用ポインタ）

このリポジトリの運用ルール・作業手順の**正本はリポジトリ直下の `AGENTS.md`**（＝各エージェント共通の
メモリ。ai-ops から配布される共通ブロックを含む）。Cline は `.clinerules/` 配下のファイルを常時
ロードするため、ここから `AGENTS.md` へ誘導する。

**作業を始める前に、必ず `AGENTS.md` を読み、その内容に従うこと。**

特定タスクでのみ必要な詳細手順は `docs/` 配下にある（例: `docs/cross-repo-tasks.md`・`docs/ci-logs.md`・
`docs/outbox-proposal.md` 等）。`AGENTS.md` 内に各手順書の**発火トリガとポインタ**が書かれているので、
該当する状況になったら対応する `docs/<name>.md` を読んでから作業する。

> このファイルはポインタのみ。ルール本体を書き足さないこと（`AGENTS.md` と二重管理になる）。
> 特定タスクの共通 SOP は `.cline/skills/<name>/SKILL.md`（description マッチで自動発火）でも拾えるが、
> 常時ルール層はこのポインタ経由で `AGENTS.md` を読むのが正。手順書の本体は常に `docs/<name>.md` 側にある。
