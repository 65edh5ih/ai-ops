# リポジトリ運用ルール（OpenHands 用ポインタ）

このリポジトリの運用ルール・作業手順の**正本はリポジトリ直下の `AGENTS.md`**（＝各エージェント共通の
メモリ。ai-ops から配布される共通ブロックを含む）。OpenHands V0 は既定で `AGENTS.md` を読み込まないため、
常時ロードされるこの repo microagent から誘導する。

**作業を始める前に、必ず `AGENTS.md` を読み、その内容に従うこと。**

特定タスクでのみ必要な詳細手順は `docs/` 配下にある（例: `docs/cross-repo-tasks.md`・`docs/ci-logs.md`・
`docs/outbox-proposal.md` 等）。`AGENTS.md` 内に各手順書の**発火トリガとポインタ**が書かれているので、
該当する状況になったら対応する `docs/<name>.md` を読んでから作業する。

> このファイルはポインタのみ。ルール本体を書き足さないこと（`AGENTS.md` と二重管理になる）。
> OpenHands V1 では `.openhands/skills/` 配下の skill が自動発火するが、V0 では読み込まれないため、
> 上記のとおり `AGENTS.md` → `docs/` の参照で手順書層をカバーする。
