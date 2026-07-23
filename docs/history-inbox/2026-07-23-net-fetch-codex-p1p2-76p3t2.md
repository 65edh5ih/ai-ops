## 2026-07-23 net-fetch: Codex レビュー指摘（P1 secret 漏洩 / P2 パストラバーサル）を修正

ai-ops#68（および同一ファイルを配布した nikki-san#636・private#401）への Codex レビュー2件を正本で修正した
（配布ファイルなので consumer PR を手編集せず ai-ops で直す）。

- **P1（secret 漏洩）**: secret を含む URL を拒否しても `emit()` が生 URL を `meta.txt` に書き、`net-fetch.yml` は
  rejected でも `net-fetch-out` を publish するため、集約モードだと**公開 `ci-logs` に secret が残る**。
  対処: `redact_secrets()` を追加し、出力に載せる URL は secret パターン＋secret 臭いクエリ値を伏字にした
  `SAFE_URL` を使う（`meta.txt` の `url=`）。workflow の Summarize も生入力ではなく伏字済み `meta.txt` から
  URL を拾う（要約は public な run ログにも出るため）。
- **P2（パストラバーサル）**: publish の `dest` に検証前の生 `request_id` を使っていたため、`../branch-cleanup/latest`
  や `..` で net-fetch/<id> スライス外へ publish できた（スクリプトが reject しても publish は `if: always()`）。
  対処: スクリプトが `request_id` を検証（`^[A-Za-z0-9._-]+$` かつ `..` を含まない）し、通らない id は
  ユーザー制御でない `net-fetch/_invalid-<ts>-<pid>` へ退避した `dest` を GITHUB_OUTPUT に出す。workflow は
  生入力ではなく `steps.fetch.outputs.dest` を publish の dest に使う。空 dest のときは publish しないガードも追加
  （空を publish-ci-logs に渡すと clone を丸ごと消しかねないため）。

学び: net-fetch の結果は集約モードで public な `ci-logs`／run ログに出るので、**出力に載る文字列（URL・dest・
要約）はすべて「拒否した入力でも安全か」を基準に組む**。拒否は「弾いて緑で publish」なので、拒否した生入力が
出力経路に載らないことまで含めて設計する。
