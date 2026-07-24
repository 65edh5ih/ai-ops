## 2026-07-24 README の下流確認 scope を列挙せず AGENTS.md 参照に一本化（Codex #72）

#72 で README に足した下流確認ポインタが scope を `shared/**`・`AGENTS_COMMON.md` と**列挙**していたため、
AGENTS.md 側で対象を `sync-deletions.txt` 等に広げた後、README だけ狭いままドリフトした（Codex 指摘）。
scope を2箇所に書くと片方だけ直してドリフトする典型。README からは**列挙を外し**「配布に影響する変更を…／
対象・手順とも正本は AGENTS.md」に変えて single-source にした（`AGENTS_COMMON`「同じ事実の正本は1つに保ち
他からリンク」）。#72 マージ後の追随なので follow-up PR。
