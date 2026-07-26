# ops-runner の公開 Codex review inbox スライスを撤去する

## 目的（なぜ）

ops-runner の `main` に ops-sync と同じ「pull request 必須」の ruleset を適用し、public repo への定期処理の
直接 push を許可しない運用へ変える。ops-sync 側の Codex review inbox workflow は ops-runner を走査対象に
残しつつ、今後は private リポジトリの全体一覧だけに結果を載せ、ops-runner 自身のスライスを更新しない。

## 作業内容（何を）

1. 既に存在する `.ops-sync/codex-review-inbox.md` を削除する。
2. このファイルは ops-sync の sync manifest 管理対象ではないため、manifest は変更しない。
3. 削除を pull request として出す。`main` へ直接 push しない。

## 完了条件

- `.ops-sync/codex-review-inbox.md` を削除する PR が作成され、必要なチェックを通っている。
- ops-runner の他の `.ops-sync/` 配下（tasks / manifest / outbox 等）を削除していない。
- 作業完了後、共通の cross-repo task 手順に従ってこの依頼の消化報告を出している。
