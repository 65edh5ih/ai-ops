## 2026-07-22 対応エージェントに Kimi / Qwen / Cursor / Cline / Windsurf を追加

### なぜ

ユーザー依頼「Kimi や Qwen も対応エージェントに追加してほしい。ほかに主要な追加漏れがあれば足す」。
配布の入口機構（native / 入口 symlink / 固定内容ポインタ / skill ミラー）のどこに載るかは各エージェントが
既定でどのファイルを読むかで決まるため、公式挙動を調べて振り分けた。

- **Kimi Code CLI（Moonshot）**: リポジトリ直下 `AGENTS.md`（および `.kimi-code/AGENTS.md`）を**ネイティブに
  読む** → Codex / Antigravity と同じく**追加配線ゼロ**。skill は明示呼び出し（`Skill` ツール）でディレクトリ
  自動発火機構が無いため mirror 対象外。
- **Qwen Code（Gemini CLI フォーク）**: 既定で `QWEN.md` を探す → `QWEN.md -> AGENTS.md` の入口 symlink
  （`apply-entrypoints.mjs` の `ALIASES`）。かつ `.qwen/skills/<name>/SKILL.md` を description マッチで自動発火
  するので `SKILL_MIRROR_ROOTS` にも `.qwen` を追加。＝Gemini と同じ二本立て（入口＋skill ミラー）。
- **Cursor / Cline / Windsurf**: 「主要な追加漏れ」として選定（利用規模上位）。いずれも常時ロードの
  ルールファイルを持つが AGENTS.md はネイティブに読まないため、Copilot / Continue と同じ**固定内容ポインタ**を
  `shared/` に置いて誘導する（入口が consumer 非依存の実ファイル＝`apply-shared` の通常配布で届き、symlink 配線は
  不要）。ポインタ本体は書かず AGENTS.md → `docs/` 参照で手順書層をカバー（skill 自動発火機構が無いため）。
  - Cursor: `.cursor/rules/ai-ops.mdc`（frontmatter `alwaysApply: true`）
  - Cline: `.clinerules/ai-ops.md`（`.clinerules/` ディレクトリ配下の Markdown を常時ロード）
  - Windsurf: `.windsurf/rules/ai-ops.md`（frontmatter `trigger: always_on`・1行目から frontmatter）

### 実装

- `scripts/apply-entrypoints.mjs`: `ALIASES` に `QWEN.md` を追加。
- `scripts/apply-shared.mjs`: `SKILL_MIRROR_ROOTS` に `.qwen` を追加。
- 新規固定内容ポインタ: `shared/.cursor/rules/ai-ops.mdc`・`shared/.clinerules/ai-ops.md`・
  `shared/.windsurf/rules/ai-ops.md`。
- `shared/docs/ops-sync-design.md`・`README.md` のエージェント別入口一覧・skill ミラー一覧・冒頭ロスターを追随。

### 検証

一時 consumer への配布で、`.qwen/skills/**` の5 skill ミラー生成・3 ポインタ配布・`QWEN.md -> AGENTS.md`
入口 symlink を実駆動確認。
