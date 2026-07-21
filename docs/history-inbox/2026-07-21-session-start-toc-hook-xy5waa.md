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
