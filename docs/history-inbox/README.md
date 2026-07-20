# history-inbox（未統合のタスク履歴フラグメント）

エージェントはタスク履歴を `docs/AI_TASK_HISTORY.md` へ直接追記せず、**1エントリ＝1ファイル**を
このディレクトリに `docs/history-inbox/<YYYY-MM-DD>-<スラッグ>.md` で置く（並行 PR のコンフリクト回避）。
ai-ops の archive-task-history バッチが本体へ統合し、フラグメントを削除する。

規約の正本: [`../task-history.md`](../task-history.md)。この README はバッチの取り込み対象外。
