## 2026-07-24 net-fetch 共通 allowlist に www.githubstatus.com を追加、hysteria の広すぎるエントリを削除

private リポジトリのセッションで GitHub の PR 作成 API が 500 を返し続けたとき、「GitHub 全体の障害か個別の
エラーか」を一次情報で判定しようと `https://www.githubstatus.com/api/v2/summary.json` を取りにいって 403 で
弾かれた。切り分け自体は他の手段（レスポンスヘッダの `Server: github.com` と `X-Github-Request-Id`、正しい
base での 500 と不正な base での 422 の対比）で確定できたが、status API が読めれば1回で済む話だった。障害の
切り分けは今後も繰り返し起きるので、認証不要・公開・非機微の status API を共通ベースに入れる。

あわせて末尾の `hysteria.network` / `*.hysteria.network` を削除した。この2行は symlink ドリフト障害
（root コピーが shared と別実体で、shared だけ直しても集約実行に効かなかった件）の切り分け中に「範囲が
狭すぎるのが原因では」と疑って足されたもので、真因が root の symlink 化で解消した今は不要。実際に必要なのは
`v2.hysteria.network` だけで、これは残っているので取得能力は落ちない。ファイル冒頭の「迷ったら足さない。
実際に必要になったドメインだけを、必要な粒度で足す」に合わせた。

なお `www.githubstatus.com` は `www.` 付きの完全一致1行だけにした（`*.githubstatus.com` は足していない）。
実際に叩くのが www ホストのみで、同じ粒度の原則に従ったため。
