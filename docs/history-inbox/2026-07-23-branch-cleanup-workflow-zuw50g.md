## 2026-07-23 stale ブランチ手動削除 workflow（branch-cleanup）を shared 配布で新設

private の Cloudflare Workers Builds 接続で Production branch 一覧に main が出ない件の根因が、
エージェント生成の stale ブランチ大量残留（private 264本・codex/claude 主体）だったため、手動トリガの
一括削除 workflow を追加。3リポジトリ（private / nikki-san / ai-ops）に同一で入れたいので shared 配布にした。

判断・ハマりどころ:
- GitHub の "Automatically delete head branches" は**マージされた PR の head しか消さない**。close/PR無し/
  設定前のブランチは残る（＝ON でも溜まる。ユーザーが「ON なのに同症状」と指摘。仕様どおり）。だから
  掃除 workflow が要る。
- **workflow ファイルの配布には token 権限の壁**: sync は `OPS_SYNC_TOKEN`（PAT）で consumer に push するが、
  GitHub は `.github/workflows/` 配下を `workflow` 権限の無い PAT で push させない。従来の shared 配布物は
  composite action（`.github/actions/`）止まりで workflow ファイルは初。**OPS_SYNC_TOKEN に Workflows 書き込み
  権限の付与が必要**（無いと sync PR の push が consumer で失敗する）。ユーザーに要通知。
- ai-ops は sync の consumer ではない（consumers.txt = nikki-san, private のみ）ため、shared の正本に加えて
  ai-ops 自身の `.github/workflows/` にも**バイト一致コピー**を置く（両方を同時に直す）。
- 安全設計: 手動のみ（workflow_dispatch）・**既定 dry-run**・既定ブランチ/keep 一覧/オープン PR head を常に
  除外・prefixes 一致 かつ age_days（既定7）より古いものだけ対象。年齢は git committerdate で判定
  （squash マージだと ancestry でマージ済み判定できないため、prefix＋年齢＋オープン PR 除外で安全側に倒す）。
- keep 既定に nikki-san 固有の hugo-bin/deploy-logs も入れて全 consumer で1ファイルを使い回せるようにした
  （存在しない repo では無害）。
