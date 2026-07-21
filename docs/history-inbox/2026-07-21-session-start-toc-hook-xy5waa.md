## 2026-07-21 session-start フックを共通化し、履歴を本文注入→見出し(TOC)注入に変更

### なぜ

「直近履歴を毎セッション自動ロード（本文丸ごと）する必要があるか」の議論の結論。業界の tiered-memory
（MemGPT/Letta の "小さな core は常時・archival はオンデマンドで page-in"、Cursor の Agent-Requested
ルール＝description だけ常時・本文は必要時）と context-rot 知見に照らし、**履歴は見出し(TOC)だけ常時注入し
本文はオンデマンド**が最も整合する、と判断（完全 on-demand は 2026-06-16 の読み忘れ regression の再来
リスクがあり不採用）。

調査で判明した実態（コードから読めない点）:

- **auto-injection は nikki-san だけ**だった。private の `session-start.sh` は githooks 有効化のみ・履歴も
  コンテキストも注入していなかった。ai-ops は SessionStart フック自体が無い。しかも両者の githooks
  有効化は**別実装でドリフト**（nikki-san=bash/`CLAUDE_PROJECT_DIR`、private=sh/`git rev-parse`）。フックも
  その登録も ai-ops 非配布の手作りコピーだった。
- ユーザー選択＝**共通フック化して全展開**。汎用 `shared/.claude/hooks/session-start.sh` を1本作り配布:
  githooks 有効化＋（`docs/AI_CONTEXT.md` があれば全文）＋**履歴 TOC 注入**。TOC はフラグメントの
  ファイル名がブランチ由来で非説明的なため、各エントリの `## ` 見出し行から作り読むべきパスを添える。

**致命的な前提: `apply-shared` は `writeFileSync` で配布し実行ビットを保持していなかった**。フックは
直接実行登録（nikki-san/private とも）なので +x が要る。`statSync(src).mode` を `chmodSync` で複写する
よう `apply-shared` を修正（既存の `.githooks/pre-push` は shared/consumer とも既に 755 で一致＝churn 無し。
以後 shared/ 側で `chmod +x` した実行ファイルは実行可能で届く）。

- **登録は配布対象外**: consumer の `.claude/settings.json` の SessionStart はローカル。nikki-san/private は
  既に同パスを登録済みなので配布実体をそのまま拾う。ai-ops 自身は SessionStart 登録が無かったので追加し、
  `.claude/hooks/session-start.sh` を shared への symlink にした（docs の symlink と同作法）。

### 検証

一時 consumer へ apply-shared 配布 → フックが **755（実行可能）**で届き manifest 登録、実行すると
AI_CONTEXT 全文＋履歴 TOC（見出しのみ・本文非注入・README 除外・フラグメントは読むべきパス付き）を
正しい JSON で出力。ai-ops 自身の symlink 経由でも動作確認。`bash -n`・`node --check`・settings.json の
JSON 妥当性も通過。

### 発見: SessionStart の出力形式が壊れていた（Codex P2）

旧 nikki-san フックの `jq -Rs '{"message": .}'` は **SessionStart では認識されない形式**だった
（公式仕様はプレーン stdout か `hookSpecificOutput.additionalContext`。トップレベル `message` は無視）。
＝**nikki-san の履歴自動注入は以前から効いていなかった**。共通フックも同じ形式で書いてしまい全 repo に
広げるところを Codex が指摘。`{hookSpecificOutput: {hookEventName: "SessionStart", additionalContext: .}}`
に修正（実駆動で JSON 形状を検証）。TOC 化と同時に「そもそも注入が効く」状態になった。

### 残タスク

nikki-san のローカル doc（AGENTS.md「セッション開始時に必ず読むこと」#2・`docs/README.md` の常時ロード
記述）は旧来の本文注入前提のままなので、TOC 方式に別 PR で追随させる（consumer ローカル・配布対象外）。
