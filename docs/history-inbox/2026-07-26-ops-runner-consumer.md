## 2026-07-26 計算基盤 `ops-runner` を consumer として追加（実行基盤分離の第1段）

エージェントが dispatch する計算（現状 net-fetch）を ai-ops から切り出すための下準備。この段階では
**配布先を1つ増やしただけ**で、net-fetch の実行先はまだ ai-ops のまま（切り替えは次段）。

### なぜ分けるか

ai-ops には `OPS_SYNC_TOKEN`（全 consumer への Contents/Workflows:RW）がある。一方 net-fetch は
**エージェントが任意のタイミングで起動でき、任意の外部 URL の中身を持ち込む唯一の経路**で、性質が
まったく違う。現時点で穴が空いているわけではない（fetch ジョブに secret を渡さない・`pull_request`
トリガが無い・fork PR は承認必須・main はブランチ保護）が、その不変条件は **workflow 1つ1つの
レビューで担保している**状態。今後この種の機能は増えるので、リポジトリ境界にして構造で保つ。

**分割線は「計算 vs 配布」ではなく「`OPS_SYNC_TOKEN` が要るか」**。archive-task-history のようなバッチは
計算だが cross-repo write が要るので ai-ops 残留。quota 信号も cron 専用で外部入力を取らないため残留。

### コストが安い理由

新リポジトリを `consumers.txt` に1行足すだけで、既存の配布機構が `net-fetch.yml`・allowlist・
`publish-ephemeral`・共通ルールを届ける。**新しい仕組みはゼロ**。分離完了後は、ai-ops が抱えている
「`shared/` の正本と root の実コピーを byte 一致で手動同期」という二重管理も消える。

### 限界（誤解しないため）

この分離は**一方向**。runner に配るには `OPS_SYNC_TOKEN` が runner にも書き込める必要があるので、
「runner が ai-ops を触れない」は成立するが「ai-ops が runner を触れない」は成立しない。守っているのは
*鍵のある場所に外部コンテンツを持ち込ませない*ことであって、鍵の影響範囲を狭めることではない。

また `ci-logs` が2箇所になる。quota 信号は ai-ops 側に残るので、分散モードのエージェントは
「枠の信号は ai-ops、取得結果は runner」と2箇所を見る。読むだけなので実害は小さいが doc で明示が要る。

### ops-runner は public

無料枠のため（private だと分を消費し、枠はアカウント単位で全 private リポジトリが共有する）。
帰結として、ここへ配る `shared/` の内容も net-fetch の取得結果も世界公開になる。機微な取得は
従来どおり private リポジトリの分散モードで行う（この分離で変わらない）。
