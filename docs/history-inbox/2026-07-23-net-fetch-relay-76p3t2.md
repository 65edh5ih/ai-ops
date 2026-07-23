## 2026-07-23 net-fetch: エージェントの代理インターネット取得リレーを共通基盤として追加

Claude Code の許可ドメイン egress が機能しない環境向けに、GitHub Actions ランナー（フルのネット接続を持つ）を
中継して**許可ドメインだけ**を取得するリレーを追加した。エージェントは egress 制限下でも GitHub には到達できる
ため、GitHub 自体を中継所にする構図。正本は `shared/`（全 consumer へ配布）、ai-ops 自身にもバイト一致コピー
（`branch-cleanup` と同じ dual placement）。

判断の経緯（コードに残らない前提・制約）:

- **集約 vs 分散**: 実行を public な ai-ops 上で回せば GitHub Actions 分が無料（既存の「ai-ops を public に
  している理由」と同じ）。ただし結果は ai-ops の `ci-logs`＝世界公開に落ちる。そこで両モードを同一 workflow
  で持ち、**どのリポジトリで起動するかだけがモードの違い**にした。現状の既定は集約（枠逼迫のため）。
- **allowlist 2層（共通配布 ∪ リポジトリ固有）**: 共通ベース `.github/net-allowlist.txt`（配布）に加え、
  各リポジトリの `.github/net-allowlist.local.txt`（配布対象外・repo 所有）を union。**機微を取得しうる
  ドメインは private リポジトリのローカルにだけ書く**運用。集約モードの判定は共通ベースのみを見るので、
  機微ドメインは構造的に public 経路を通れない（配置がルールを強制する。人の規律に依存しない）。
  `.local.txt` を配布しない（shared に置かない）のは、置くと manifest 管理下になり同期で上書きされ
  「repo 所有」でなくなるため。
- **secret を fetch に含めさせない縛り**: 取得ジョブに secret を一切渡さない（クリーンルーム）を第一の
  構造的縛りにし、request の URL/クエリの secret パターン拒否・response の secret 伏字を二層目に置いた。
  publish（ci-logs へ push）に使う github.token は取得ステップの env に載せない。
- **consumer 側に dispatch トークンを置かない**: エージェントは自前の GitHub 資格情報で workflow_dispatch
  する。過去に上りの即時化で置いた `OPS_DISPATCH_TOKEN`（consumer→ai-ops 書き込み）を「ルール正本への
  増幅経路」として撤去した経緯（→ ops-sync-design.md）と同じ理由で、consumer に常設トークンを増やさない。
- **SSRF ガード**: allowlist と無関係に、https 以外・URL 内資格情報・IP リテラル・localhost・クラウド
  メタデータ（169.254.169.254 等）・リダイレクト追従を常に禁止。allowlist はドメイン前提なので通常は
  一致しないが、明示的に弾いて意図を固定した。
- **枠連動（quota-gate）は今回作らない**が、あとで共通基盤として差し込めるよう継ぎ目を用意した。集約/分散の
  両実行経路は既に存在するので、将来足すのは「枠残量でどちらを選ぶか」の判定層だけ（この workflow・SOP は
  変更不要）。枠残量は billing API 経由（PAT 必須・アカウント単位・遅延あり）でしか取れないことも確認済み。

学び: 新規 shared workflow なので docs/ci-logs.md に従い publish-ci-logs を組み込む必要があるが、net-fetch は
「取得結果そのものを per-request スライスへ publish する」ことが inline publish を兼ねる（別途 logs/ci/scripts を
足さず、結果 publish で要件を満たした）。
