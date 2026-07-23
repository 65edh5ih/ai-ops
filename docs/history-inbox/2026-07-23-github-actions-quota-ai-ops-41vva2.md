## 2026-07-23 ai-ops を public 化（GitHub Actions 分数の枯渇対策）

ユーザー相談「Actions の月枠が切れそう。履歴アーカイブやリポジトリ間同期をやっている ai-ops を public に
しようと思うが注意点は？」を受けて public 化した。

- **なぜ public 化か**: 月内の Actions 残枠が20分未満まで枯渇し、ai-ops 自身の運用 workflow
  （sync / archive-task-history / collect-outbox）が枠切れで止まりかけていた。consumer（nikki-san / private）は
  既に Cloudflare Workers デプロイへ移行済みで、deploy が主犯ではない。**public repo は GitHub-hosted runner の
  Actions が無料**（アカウント枠を消費しない）ため、ai-ops 自身の workflow を枠から外すのが目的。
  consumer は private のままなので、そちらの Actions 分数は救われない（切り分けて認識する）。
- **public 化前の棚卸し（実施済み・クリア）**: 全 git 履歴の diff を secret パターンで走査 → 混入なし。
  インフラ機密（IP 帯・pfSense・sing-box 等）は private repo 本体にあり ai-ops にはミラーされていない。
  過去に private 宛だった `tasks/` ファイルの中身も運用手順のみ。残る露出は「`65edh5ih/private` という
  非公開 repo の存在」と運用メタ（PR 番号・workflow 名・構成メモ）のみで、これは許容と判断した。
- **入れたガード**: ①`main` のブランチ保護（無料アカウントでは **public でのみ enforced**。private 中は
  "Not enforced" 表示が正常で、public 化の瞬間に自動で効く）。承認必須は **0** にする（archive/collect が
  `gh pr merge` で自分の PR を PAT 自動マージするため、1以上にすると自動化が止まる）。②Settings → Actions →
  General の fork PR を **Require approval for all external contributors**（UI 文言が outside collaborators から
  改称された同一設定）。
- **なぜガードが要る/効く**: 唯一の機微は `OPS_SYNC_TOKEN`（全 consumer への Contents:RW/PR:RW を持つ合鍵）。
  Actions secret なので**可視性変更では露出しない**。かつ ai-ops の workflow はどれも `pull_request` で
  起動しないため fork PR からトークンを窃取する経路が構造的に無い（fork 承認制は二重の保険）。
- **PR #63 との関係**: stale ブランチ削除 workflow の shared 配布は `OPS_SYNC_TOKEN` に Workflows:write を
  要求する（設計が意図的に避けていた格上げ）。ただし PAT は既に Contents:RW を持つ＝既にクラウンジュエルで、
  増分は categorical でなく incremental。public 化は PAT の漏洩確率を上げない（上記の理由）ため、docs 更新
  （README・ops-design のトークン表）＋スコープ付与を条件に許容可、と整理した。
- 恒久的な運用前提（ai-ops=public / consumer=private の可視性モデルと帰結）は `shared/docs/ops-sync-design.md`
  「前提・限界」に現在形で記載した。
