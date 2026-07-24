## 2026-07-24 net-fetch: 共通 allowlist を root symlink 化（ドリフト解消）＋伏字境界を拒否と一致

#70 マージ後、ユーザーが `shared/.github/net-allowlist.txt` に `hysteria.network` / `*.hysteria.network` を
直接足したが、ai-ops 自身の集約実行が読む **root コピー `.github/net-allowlist.txt` が更新されず**、集約モードで
`hysteria.network` が拒否され続けた（Codex #70 が指摘。「shared だけ更新、root は未反映」）。dual placement
（branch-cleanup と同じ byte-identical copy 方式）を allowlist に使うと、手編集で片側だけ直すドリフトが起きる。

対処:

- **root `.github/net-allowlist.txt` を `../shared/.github/net-allowlist.txt` への symlink に変更**。ai-ops の
  集約実行は symlink 越しに shared の正本を読むので、**手編集は shared 一箇所だけ**でよくなり構造的にドリフトしない
  （`docs/*.md -> ../shared/docs/*.md` と同じ作法。workflow/action は Actions が実ファイルを要求するので copy の
  ままだが、allowlist は script が読むデータなので symlink で問題ない）。consumer には従来どおり sync が実ファイルを配る。
- **伏字境界を拒否パターンと一致**（Codex #70 P2）: `SECRET_QUERY_KEYS` の拒否は `key=` を位置を問わず一致させるのに、
  `redact_secrets` は `?`/`&` 直後の `key=` しか伏字にしていなかった。`https://example.com/path;access_token=secret` は
  拒否されるが `SAFE_URL` に生値が残り公開 ci-logs に漏れうる。伏字の `[?&]` アンカーを外し、値終端を
  `[^[:space:]&#;]*` にして拒否と同じ広さにした。

collector 例外の明文化（ルール整合）: 「新規ワークフローは collector に登録する」は codified rule（`ci-logs.md` 手順4・
nikki-san の DEPLOY_LOGGING_DESIGN.md チェックリスト）。net-fetch を登録しない判断を**ルール未修正のまま放置していた
＝サイレント違反**だったので、`shared/docs/ci-logs.md` に「リクエスト単位で毎 run inline publish するワークフロー
（net-fetch）は collector 登録の対象外」を根拠付きで明記した（黙って回避せず、逸脱はルール側に書く）。

なぜ private に collector が無いか: collector は**リポジトリ固有で配布物ではない**うえ、private は nikki-san とは
**別のログ設計**を採る。private の `deploy-workers.yml` は各 deploy ログを `deploy-logs/<worker>.log` に書いて
artifact 化し、`commit-logs` ジョブが `cloudflare_workers/deploy-logs/` に**コミットして**残す方式で、nikki-san の
`ci-logs` ブランチ＋`publish-ci-logs`＋`collect-deploy-run-logs.yml` の2層モデルを使っていない。よって private に
collector が無いのは抜けではなく設計差（Codex が collector 登録を nikki-san#636 でだけ挙げたのも、collector が
あるのが nikki-san だけだから）。net-fetch 配布で private にも `ci-logs` 系が入り、native の deploy-logs 方式と併存する。

学び: 「片方を直したらもう片方も直す」値（同一 allowlist の2コピー）は、AGENTS_COMMON「コードの重複に気づいたら
共通部品化」の典型。ai-ops 内で同一内容を複数パスに置くなら symlink にして正本を1つに保つ（ops-sync-design の作法）。
