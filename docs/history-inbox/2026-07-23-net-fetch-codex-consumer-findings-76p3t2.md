## 2026-07-23 net-fetch: consumer 同期 PR の Codex 追加指摘（注入・PEM・クエリ）を正本で修正

nikki-san#636 / private#401（net-fetch を配布した同期 PR）への Codex レビューが、ai-ops#68 には無かった
**追加の指摘**を出していた。配布ファイルなので正本 ai-ops で直し、sync で全 consumer へ再配布する。

- **スクリプト注入（nikki-san P1・重大）**: workflow の Summarize `run:` に `${{ inputs.request_id }}` を生で埋めており、
  GitHub が bash 実行前に展開するため `request_id=$(...)` で任意コマンド実行できた（fetch が reject しても
  `always()` の要約ステップで走る）。#70 の初回修正で `url` の生埋め込みは消したが **`request_id` を残していた**。
  対処: 動的値をすべて `env:` 経由で渡し、`$VAR` を `printf` する（env の値は再評価されない）。URL は伏字済み
  meta.txt から拾う。
- **PEM ブロック未伏字（private P2）**: `-----BEGIN … PRIVATE KEY-----` パターンは BEGIN 行しか一致せず、行単位の
  sed 伏字だと base64 本文・END が response.txt に残っていた（集約モードで公開 ci-logs に落ちる）。
  対処: `redact_file()` を追加し、awk で BEGIN〜END を丸ごと `[REDACTED-PRIVATE-KEY]` に置換してから token 類を sed。
- **クエリ/フラグメントで allowlist 誤判定（private P2）**: host 抽出がパスの無い `https://example.com?x=1` /
  `#frag` で `?`/`#` を落とさず、`example.com?x=1` を allowlist と突き合わせて**許可済みでも拒否**していた。
  対処: host 抽出で `?` と `#` も除去。
- **collector 登録（nikki-san P2）**: 「新規 workflow はフル生ログ collector の一覧へ失敗時ゲートで登録」は
  **リポジトリ固有**（collector `collect-deploy-run-logs.yml` と設計 doc は nikki-san ローカル・配布対象外）。
  正本では直せないので nikki-san 側のローカル変更で対応する（別 PR）。

- **userinfo 資格情報の漏洩（#70 への再レビュー P1）**: `SAFE_URL` は token パターンとクエリ値しか伏字にせず、
  `https://user:pass@host/` の `user:pass@` を残していた。userinfo チェックで fetch は reject するが `emit` は
  `SAFE_URL` を `meta.txt` に書く→集約モードで公開 ci-logs に資格情報が残る。対処: `redact_secrets` に
  `s|(://)[^/?#@]*@|\1[REDACTED-USERINFO]@|` を追加（パス/クエリ中の `@` は `/?#` 境界で誤爆しない）。

学び: 配布物への指摘は「同一ファイルを持つ全 consumer 分」を1回で正本修正すれば足りるが、consumer ごとに
Codex が見る文脈（各 repo の AGENTS.md・collector 有無）が違い、**consumer PR にしか出ない指摘**もある
（今回の注入・PEM・クエリは #68 に出ず #636/#401 で出た）。配布した net-fetch のレビューは consumer 側 PR も
必ず確認する。workflow の `run:` に `${{ inputs.* }}` を生で埋めない（env 経由）ことは全 workflow 共通の鉄則。
