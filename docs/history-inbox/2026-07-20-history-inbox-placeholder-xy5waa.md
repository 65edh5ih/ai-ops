## 2026-07-20 history-inbox を空にしても消えないよう配布プレースホルダ化

### なぜ

フラグメント方式の統合バッチ（archive-task-history）が nikki-san のフラグメントを取り込んで
`docs/history-inbox/` を空にした自動 PR（nikki-san #606）に、Codex P2 が付いた: git は空ディレクトリを
追跡しないため、全フラグメント統合後の fresh checkout では **規約が「書き込み先」と定める
`docs/history-inbox/` ごと消える**。次セッションで素朴な `cat >`・`find`・`ls` が失敗しうる。

実際、ai-ops の history-inbox は #50 で置いた `README.md` のおかげで統合後も生き残っていた（＝プレース
ホルダが効くことの実証）。一方 private・nikki-san は README を置いていなかったため消えた。

**最も堅牢な直し方＝プレースホルダ `README.md` を ai-ops の配布ファイルにする**:

- `shared/docs/history-inbox/README.md` を新設 → apply-shared が全 consumer の
  `docs/history-inbox/README.md` として配布し、**ディレクトリを追跡状態で常設**する。sync は cron でも
  再適用されるので、#606 で消えた nikki-san も次回 sync で自動復活する（per-repo の手当て不要・
  新規 consumer も自動でカバー）。
- バッチは元から `README.md` を取り込み対象外にしていた（`toLowerCase() !== 'readme.md'`）ので、
  統合で消えない。役割をコメントと `task-history.md` に明記した。
- ai-ops 自身の `docs/history-inbox/README.md` は実ファイルをやめ、`../../shared/docs/history-inbox/
  README.md` への symlink に統一（既存の `docs/task-history.md` symlink と同作法・drift 防止）。

### 検証

apply-shared を temp consumer へ実行 → `docs/history-inbox/README.md` がディレクトリごと配布され
manifest にも載ることを確認。続けて archive-task-history でフラグメントを統合 → README が残り
ディレクトリが存続することを確認。

### 補足（PR #52 レビュー対応）

配布対象を足したので、ai-ops 完了手順どおり `shared/docs/ops-sync-design.md` と `README.md` の
タスク履歴統合フローに、この管理プレースホルダの記述を追加（Codex P2 指摘。将来のエージェントが
「なぜこの README を配布し続けるか」を見失って関連変更で落とさないため）。
