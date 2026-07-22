## 2026-07-22 対応エージェントに Kimi / Qwen / Cursor / Cline / Windsurf を追加

### なぜ

ユーザー依頼「Kimi や Qwen も対応エージェントに追加してほしい。ほかに主要な追加漏れがあれば足す」。
配布の入口機構（native / 入口 symlink / 固定内容ポインタ / skill ミラー）のどこに載るかは各エージェントが
既定でどのファイルを読むかで決まるため、公式挙動を調べて振り分けた。

- **Kimi Code CLI（Moonshot）**: リポジトリ直下 `AGENTS.md`（および `.kimi-code/AGENTS.md`）を**ネイティブに
  読む** → Codex / Antigravity と同じく**追加配線ゼロ**。skill は明示呼び出し（`Skill` ツール）でディレクトリ
  自動発火機構が無いため mirror 対象外。
- **Qwen Code（Gemini CLI フォーク）**: 当初 `QWEN.md -> AGENTS.md` の入口 symlink を張ったが、Codex レビュー
  指摘（PR #57）＋公式 memory doc 確認で **Qwen は既定の `QWEN.md` に加えリポジトリ直下の `AGENTS.md` も読む**
  （"if your repository already has an AGENTS.md file … Qwen reads that too"）と判明。symlink を張ると共通ブロックが
  QWEN.md と AGENTS.md から**二重ロード**になるため撤回し、**native-AGENTS 扱い（入口 symlink なし）**に修正。
  一方 `.qwen/skills/<name>/SKILL.md` は description マッチで自動発火するので `SKILL_MIRROR_ROOTS` の `.qwen` は
  維持。＝入口は native・skill だけミラーする組み合わせ（Gemini のような二本立てにはしない）。
- **Cursor / Cline / Windsurf**: 「主要な追加漏れ」として選定（利用規模上位）。いずれも常時ロードの
  ルールファイルを持つが AGENTS.md はネイティブに読まないため、Copilot / Continue と同じ**固定内容ポインタ**を
  `shared/` に置いて誘導する（入口が consumer 非依存の実ファイル＝`apply-shared` の通常配布で届き、symlink 配線は
  不要）。ポインタ本体は書かず AGENTS.md → `docs/` 参照で手順書層をカバー（skill 自動発火機構が無いため）。
  - Cursor: `.cursor/rules/ai-ops.mdc`（frontmatter `alwaysApply: true`）
  - Cline: `.clinerules/ai-ops.md`（`.clinerules/` ディレクトリ配下の Markdown を常時ロード）。加えて Cline は
    v3.48〜 skill（`.cline/skills/<name>/SKILL.md`）を description マッチで自動発火するため（Codex レビュー指摘
    ＋公式 skill doc で確認・PR #57）、`SKILL_MIRROR_ROOTS` にも `.cline` を追加。常時ルールは `.clinerules/`
    ポインタ、SOP は `.cline/skills/` ミラーの二本立て（Gemini/Qwen と同じ構成）。Cursor/Windsurf は SKILL.md
    標準を未採用のためポインタのみ。
  - Windsurf: `.windsurf/rules/ai-ops.md`（frontmatter `trigger: always_on`・1行目から frontmatter）

### 実装

- `scripts/apply-shared.mjs`: `SKILL_MIRROR_ROOTS` に `.qwen`（Qwen）・`.cline`（Cline）を追加。
- `scripts/apply-entrypoints.mjs`: Qwen は native-AGENTS 扱いのため `ALIASES` は変更なし（QWEN.md symlink は
  張らない）。コメントにその理由（二重ロード回避）を明記。
- 新規固定内容ポインタ: `shared/.cursor/rules/ai-ops.mdc`・`shared/.clinerules/ai-ops.md`・
  `shared/.windsurf/rules/ai-ops.md`。
- `shared/docs/ops-sync-design.md`・`README.md` のエージェント別入口一覧・skill ミラー一覧・冒頭ロスターを追随。

### 検証

一時 consumer への配布で、`.qwen/skills/**` の5 skill ミラー生成・3 ポインタ配布を実駆動確認（Qwen 入口 symlink は
仕様どおり張られないことも確認）。
