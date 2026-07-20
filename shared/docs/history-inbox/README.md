# history-inbox（未統合のタスク履歴フラグメント）

エージェントはタスク履歴を `docs/AI_TASK_HISTORY.md` へ直接追記せず、**1エントリ＝1ファイル**を
このディレクトリに `docs/history-inbox/<YYYY-MM-DD>-<スラッグ>.md` で置く（並行 PR のコンフリクト回避）。
ai-ops の archive-task-history バッチが本体へ統合し、取り込んだフラグメントを削除する。

この `README.md` は**ディレクトリを常に git 追跡状態に保つための意図的なプレースホルダ**（消さない）。
フラグメントを全部統合するとディレクトリが空になり、git は空ディレクトリを追跡しないため、
これが無いと fresh checkout で「書き込み先」ディレクトリごと消えてしまう。バッチはこのファイルを
取り込み対象から除外する。ai-ops が配布・維持する（手編集しない。直したいときは outbox 提案）。

規約の正本: [`../task-history.md`](../task-history.md)。
