## 2026-07-24 net-fetch: SOP を非 Claude エージェント向けにツール中立化

ユーザーから「net-fetch の GitHub Actions は Claude Code 以外のエージェントで問題を起こさないか」と問われ、評価した。

評価の結論:

- **インフラ本体は問題なし**。workflow / composite action / net-fetch.sh は完全にエージェント非依存で、
  allowlist・SSRF ガード・secret スキャン/伏字・クリーンルームは全部 GitHub Actions 側（サーバ側）で enforce する。
  誰が `workflow_dispatch` しても同じ保護。配布も `apply-shared.mjs` が SKILL を `.codex/.openhands/.gemini/.agents/
  .qwen/.cline` へミラーするので全エージェントが見える。常時注入ではなく on-demand skill 層なので、発火しなければ不活性で
  他エージェントの通常タスクを壊さない。
- **ギャップは SOP の文面**にあった。`shared/docs/net-fetch.md` が Claude Code on the web 固有のツール語彙前提で、
  他エージェント（Codex/Gemini CLI/OpenHands/Qwen/Cline）では次が噛み合わない:
  - step 2/3 の `add_repo`（別リポジトリのセッション追加）は Claude-web 固有ツール。集約モードは「public な ai-ops に
    add_repo して dispatch」する構成なので、これを持たない他エージェントは**既定の集約パスの最初で詰まる**。
  - step 4「workflow_dispatch で起動」・step 5「ci-logs ブランチを読む」は具体手段を書かず特定ツール前提だった。

対処（`shared/docs/net-fetch.md` のみ改訂。SKILL ラッパーと AGENTS_COMMON の常時ブロックは中立・最小なので不変）:

- **能力ベースの前提節を追加**: 「dispatch できる」「ci-logs を読める」「（集約なら）ai-ops を参照できる」を*能力*として列挙し、
  何で満たすか（MCP/`gh`/REST/`git fetch`）はランタイム依存と明記。**満たせなければ停止してユーザーに依頼**（MUST）。
- **モードの適用範囲を明記**: 集約は `add_repo` 等（別リポジトリのセッション追加）が前提。その手段を持たないエージェントは
  **分散モード（作業中リポジトリで完結）を既定**にする。ただし「可視性・機微性でモードを選ぶ」MUST は保ち、能力制約で集約が
  *使えない*ことは、allowlist 回避目的の**モード切替（MUST NOT）とは別**として carve-out した。
- step 4/5 をツール中立化（`gh workflow run` / REST dispatch / `git fetch origin ci-logs` を例示、手段は不問）。

なぜインフラを変えずに doc だけ直したか: セキュリティ保証はサーバ側にあり、エージェント差はワークフローの起動主体だけ。
壊れるのではなく「Claude-web 固有名で書かれた手順が他エージェントで実行不能」というグレースフル劣化だったので、正本 doc の
表現をツール中立にすれば全エージェントで使える（同一ファイルを配る性質上、1回の正本修正で全 consumer 分が直る）。

配布影響あり（`shared/**`）なので、マージ後に consumer 同期 PR（head `ai-ops/sync-common`）の Codex レビュー・CI を見届ける。
