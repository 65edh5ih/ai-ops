## 2026-07-26 net-fetch: request_id に貼られた secret が公開結果に残る穴を塞ぐ

P1 のトリアージで net-fetch 系4件を実地確認した結果、**3件は既に修正済みで resolve だけされていない**もの
（2026-07-23 に返信付きで直っていた）、**1件だけが本物**だった。

本物のほう（ops-runner #1）: `request_id` の検証が文字種（`^[A-Za-z0-9._-]+$`）と `..` だけで、
**secret 判定を通していなかった**。GitHub token（`ghp_...`）等は文字種を素通りするので、request_id に
secret を貼ると (1) publish 先パス `net-fetch/<id>`、(2) `meta.txt` の `request_id=`、(3) ジョブログ、の
3経路に生のまま残る。**集約モードの実行先 ops-runner は public** なので世界公開に落ちる。URL 側は
`matches_secret` で弾いているのに、id 側だけ抜けていた（同じ出力に載るのに基準が非対称だった）。

対処: id 検証に `matches_secret` を追加（2箇所の検証条件を揃える）し、出力に載せる id は
`redact_secrets` を通した `SAFE_REQUEST_ID` にした。あわせて `matches_secret` の定義を前方へ移した
——bash は定義を実行するまで関数を呼べず、id 検証は定義より前にあったため。

実駆動で確認: `ghp_...` 形は `invalid request_id` で拒否され `meta.txt` は `[REDACTED-SECRET]`、
通常 id は従来どおり通過、`../escape` も従来どおり拒否。

教訓: **同じ出力に載る入力は、同じ基準で検査する。** URL には secret 判定・SSRF ガード・allowlist と
何重にも掛けていたのに、隣にある request_id は「パスに使うから」という理由で path traversal だけ見ていた。
入力ごとに「何に使うか」で検査を設計すると、出力経路が共通であることを見落とす。
