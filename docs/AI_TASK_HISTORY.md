# ai-ops 作業履歴

ai-ops での作業の「**なぜ**」の記録。書き方・アーカイブは共通規約 [`task-history.md`](task-history.md) に従う
（consumer に影響する変更・内部だけの変更の区別なくここ1箇所 → [`AGENTS.md`](../AGENTS.md)「履歴ファイル」節）。

---

## 2026-07-21 archive-task-history: 退避時に既存アーカイブと日付降順マージ

- `archive-task-history.mjs` の archive フェーズは、超過エントリを年ファイルの**先頭に prepend**
  するだけだった。前進運用（時間が進むだけ）では問題ないが、既にアーカイブ済みのエントリより
  **古い日付のフラグメントを後から流す**（例: バックデートした history-inbox エントリ）と、その古い
  エントリが新しいアーカイブ済みエントリの上に挿入され、年内の「新しいものが上」が局所的に崩れていた。
- 修正: moved と既存 tail をブロック単位で結合し、日付降順に安定ソートしてから書き戻す。同一日付は
  今回分（moved）が既存より上（本体統合が inbox を main より前に置くのと同じ扱い）。データ喪失・
  クラッシュは元々無く、順序のみの不具合だったが、履歴の可読性が目的なので直した。
- 発端: nikki-san の PR 処理でバックデートしたフラグメント（実作業日 2026-07-19）を扱った際、
  この挙動をユーザーと確認して見つかった。テスト基盤が無いため一時検証スクリプトで
  バックデート／前進運用／新規作成の3ケースを確認済み（コミットはしない）。

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

## 2026-07-20 タスク履歴をフラグメント方式（history-inbox）に変更

### なぜ

ユーザーから「作業履歴ファイルはコンフリクトを起こしやすいので、別ファイルに書かせてバッチであとで
統合すれば」という提案。`docs/AI_TASK_HISTORY.md` は「新しいエントリが上」＝全セッションが**先頭行に
挿入**するため、並行 PR がほぼ確実にコンフリクトし、アーカイブバッチの自動 PR とも衝突しうる構造だった
（エントリの書き方を工夫しても直らない構造上の問題）。changelog の towncrier / changelog.d と同型の
「1エントリ＝1新規ファイル」にして、各セッションが別々のパスに触れるようにし衝突を原理的に消す。

判断の核（コードから読めない点）:

- **ファイル名の一意性が方式の要（MUST）**: 同名フラグメントを別ブランチで作ると add/add コンフリクトに
  なり、方式の意味が失われる。`<スラッグ>` は作業ブランチ名から採る（このリポジトリ運用のブランチ名は
  末尾ランダム片を持つので一意）と規約に明記した。1依頼=1PR=1ブランチなので実質衝突しない。
- **読む側を必ず2箇所にする**: 統合前の最新エントリは inbox にしか無い＝一番読まれるべきもの。
  セッション開始時の参照を「本体＋`history-inbox/` の全ファイル」に変更（AGENTS_COMMON・task-history 規約・
  skill description・Stop フックを同時に追随）。ここを落とすと「最新の文脈だけ見えない」最悪の穴になる。
- **バッチ頻度は日次のまま**: 衝突回避はバッチ頻度に依存せず達成される（統合は housekeeping）。統合前も
  inbox を読めば最新は拾えるので、PR churn を増やしてまで高頻度化しない。
- **`merge=union` 案を採らない**: GitHub のサーバサイドマージはカスタム merge 戦略を尊重しないため、
  肝心の PR マージ時のコンフリクトが解消されない。分割方式が明確に優る。
- **スクリプトはリネームせず機能拡張**（`archive-task-history.mjs` の名は多所から参照。archive は中核機能の
  まま、consolidate を前段に追加）。inbox の README・見出し無しファイルは取り込み対象外で削除もしない。

### 検証

`archive-task-history.mjs` を fixture で実駆動: (1) 2フラグメント統合＋保持超過1件アーカイブ、
(2) readme/見出し無しのみ＝保持内で no-op（冪等）、(3) 本体不在からの初回起こし、いずれも期待通り。
