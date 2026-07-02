# tasks/ — リポジトリ横断タスクの置き場

`tasks/<owner>/<repo>/<YYYY-MM-DDThhmmss-説明>.md` を置くと、sync workflow が対象 consumer の
`.ai-ops/tasks/` へ配布する（この README は配布されない。配布対象は `tasks/<owner>/<repo>/` 配下のみ）。

- **起票**: consumer のエージェントが outbox（`種別: task`）で提案するか、ai-ops で直接コミットする。
- **消化**: 対象 consumer のエージェントが outbox（`種別: task-done`）で報告するか、ai-ops で
  直接ファイルを削除する。削除は次回 sync で consumer 側 `.ai-ops/tasks/` にも伝播する。
- 書き方・運用の詳細: [`shared/docs/cross-repo-tasks.md`](../shared/docs/cross-repo-tasks.md)
