# AGENTS.md のレビュー在庫の節を新しいパス・名前に合わせる

## 目的（なぜ）

ops-sync の未対応在庫の仕組みを、**Codex 限定から全レビューへ**広げた。未 resolve のレビュースレッドは
投稿者を問わず在庫に載るようになり、それに合わせて workflow・生成物を `codex-review-inbox` から
`review-inbox` へ改名した。

生成物そのもの（`.ops-sync/review-inbox.md` / `.ops-sync/review-inbox-all.md`）は workflow が直接
push するので放っておけば入れ替わる。**共通ブロック（`AGENTS.md` のマーカー区間）も同期で追随する。**
しかし**このリポジトリのローカルな記述は自動では直らない**ので、旧名のまま残ってリンク切れになる。

## 作業内容（何を）

`AGENTS.md` の**マーカー区間の外**（このリポジトリ固有パート）にある、レビュー在庫についての節を直す。
現在は次のようになっている（節見出しと本文の3行）:

```markdown
## Codex レビューの未対応在庫（全リポジトリ分をここがホスト）

このリポジトリの分だけを読むときは共通ブロックのとおり `.ops-sync/codex-review-inbox.md`。加えて
**[`.ops-sync/codex-review-inbox-all.md`](.ops-sync/codex-review-inbox-all.md)** に**全リポジトリ分**が
リポジトリごとにグループ化されて置いてある（ここがホストしているだけで、このリポジトリ固有の一覧ではない）。
```

直すのは次の3点:

1. 節見出しの「Codex レビューの未対応在庫」→「レビューの未対応在庫」。
2. `.ops-sync/codex-review-inbox.md` → `.ops-sync/review-inbox.md`。
3. `.ops-sync/codex-review-inbox-all.md` → `.ops-sync/review-inbox-all.md`（リンク先の相対パスも）。

あわせて、**同じ主張を述べている箇所を概念で洗って全部直す**（共通ブロック「ドキュメントは現在形で書く」）。
`AGENTS.md` 以外にも、このリポジトリのローカル doc（`docs/reference/` 等）や `docs/README.md` の構成表に
「Codex レビューの在庫」「`codex-review-inbox`」を指す記述があれば同じ PR で直す。
`docs/history-archive/` と `docs/incidents/` は**凍結記録なので触らない**。

> 注: マーカー区間の中と `docs/` の配布 doc は同期で入れ替わるので手で編集しない
> （手編集しても次回同期で上書きされる）。直す対象はローカルな記述だけ。

## 完了条件

- `AGENTS.md` のローカルパートに `codex-review-inbox` が1つも残っていない。
- `git grep -n "codex-review-inbox"` の結果が、`docs/history-archive/`・`docs/incidents/`・
  同期管理下のファイル（`.ops-sync/sync-manifest.txt` に載っているもの）・**`.ops-sync/` の生成物**
  だけになっている。生成物（旧名の `.ops-sync/codex-review-inbox.md`・`.ops-sync/codex-review-inbox-all.md`
  と、新名ファイルの本文に残る旧名の記述）は workflow が次回実行で消す・書き換えるので**手で触らない**
  （この作業中はまだ残っていることがある）。
- 上記を含む PR を open にし、URL をユーザーに伝えてある。

## 消化

実装 PR に `種別: task-done` の outbox 提案を含める（`docs/cross-repo-tasks.md` の「受ける側」手順3）。
完了条件はマージ時点で確定するので、後出しにする必要はない。
