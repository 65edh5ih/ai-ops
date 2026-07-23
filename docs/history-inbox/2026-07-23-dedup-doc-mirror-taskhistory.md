## 2026-07-23 dedup 挙動を共通ルール task-history.md にも反映（#60 follow-up）

- **なぜ**: #60（consolidate の dedup 追加）マージ後、Codex P2 が正本ルール `shared/docs/task-history.md` を
  指摘。統合の説明が「全フラグメントを本体へ取り込んでから削除」のままで、dedup パス（本体に既にある同一
  本文は取り込まず削除して掃除）と食い違い、重複のみの掃除 PR では正本手順が実挙動の逆を書いている状態だった。
- **対応**: 「統合とアーカイブ」節の consolidate 説明に dedup 例外を1文追記（見出しだけの一致では消さない、も明記）。
  #60 は既にマージ済みでブランチも削除されていたため、規約どおり最新 main から branch を切り直して cherry-pick
  し、別 PR として出した（マージ済み PR には積まない）。
- ops-sync-design.md・README は #60 で反映済み。3つ目の同期先が task-history.md（配布される正本ルール）。
