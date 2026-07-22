# ai-ops 作業履歴

ai-ops での作業の「**なぜ**」の記録。書き方・アーカイブは共通規約 [`task-history.md`](task-history.md) に従う
（consumer に影響する変更・内部だけの変更の区別なくここ1箇所 → [`AGENTS.md`](../AGENTS.md)「履歴ファイル」節）。

---

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

## 2026-07-21 session-start フックを共通化し、注入は AI_CONTEXT だけ・履歴は on-demand に

### なぜ

「直近履歴を毎セッション自動ロードする必要があるか」の議論の最終結論。段階的に詰めた:

- 当初 tiered-memory に倣い「履歴は見出し(TOC)注入」案だったが、調査で **auto-injection は nikki-san だけ**、
  private はフック=githooks 有効化のみ、ai-ops はフック無し、と判明（しかも githooks 有効化は両者で別実装に
  ドリフト）。ユーザー選択で**共通フック1本に統一して全展開**。
- レビュー(Codex)で **SessionStart の出力形式が壊れていた**ことが発覚: `{"message":...}` は認識されず、
  公式仕様は `hookSpecificOutput.additionalContext` かプレーン stdout（docs 確認済み）。＝**nikki-san の
  自動注入は AI_CONTEXT も履歴も"以前から丸ごと効いていなかった"**。実際に効いていたのは前段の githooks 有効化だけ。
- その「効いていないのに困らなかった」＝**指示ベース on-demand が本当の load-bearing 機構**だった証拠。
  実際このセッションでも AI_CONTEXT.md はフックでなく AGENTS.md「必ず読むこと」に従って Read された。
  ユーザー曰く 2026-06-16 の取りこぼしは作業モデルが Haiku だったため（今後 Haiku には作業させない）。
- 最終方針: **本当に毎回要るものだけフックで確実に注入する**。真の必読で cost-neutral（どのみち読むので
  占有トークン同じ・保証と往復削減が得）な **AI_CONTEXT だけ注入**。履歴は毎回は要らない（過去参照時のみ）
  ので**注入しない**——AGENTS「タスク履歴（短期記憶）」の指示で on-demand。archive 運用は housekeeping と
  して残す（A）。

### 実装

- `shared/.claude/hooks/session-start.sh`（配布）= githooks 有効化＋`docs/AI_CONTEXT.md` があれば
  `hookSpecificOutput.additionalContext` で注入（無ければ無出力）。**AI_CONTEXT は nikki-san のみ存在**
  （private は infra/docs/・ai-ops は無し）なので実質 nikki-san だけ発火。他 repo は githooks のみで正しい。
- `scripts/apply-shared.mjs`: 配布時に正本の**実行ビットを保持**（`statSync`→`chmodSync`）。フックは直接
  実行登録のため +x 必須（既存 .githooks/pre-push は 755 一致で churn 無し）。
- ai-ops 自身: フックを shared への symlink にし、`.claude/settings.json` に SessionStart 登録を追加。
- ops-sync-design.md・README.md を追随（実行ビット保持・注入は AI_CONTEXT のみ・登録は repo ローカル）。

### 検証

一時 consumer への配布でフックが 755 で届き、AI_CONTEXT ありで additionalContext 注入・無しで無出力（githooks
のみ）を実駆動確認。JSON 形状・`bash -n`・`node --check`・settings.json 妥当性 通過。

### 残タスク

nikki-san のローカル doc: AI_CONTEXT はフック注入されるので必読リストに残す（保証される旨）、**履歴は
必読から外して read-when-relevant に**（共通ブロックが受け皿）。別 PR（#618）で追随。

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
