## 2026-07-30 net-fetch の public 側の痕跡を定期 sweep 側で消し切る

#126 の続き。#126 は「読了後の cleanup dispatch を主経路にする」までで、**公開時間の上限が
エージェントの協力に依存していた**（cleanup を投げ損ねると TTL 3日＋sweep 1日 ≒ 4日残る）。
指摘を受けて、上限の担保を**エージェント非依存の側（public の定期 sweep）に移した**。

**判断の軸**: public は Actions 無料なので、ワークフロー側の仕事を増やすコストが 0。
一方エージェントは落ちる・忘れる・中断されるので、**MUST と書いても強制力がない**。
よって「エージェントの cleanup ＝ 正確な信号（秒で消す最適化）」「定期 sweep ＝ 上限の担保」に
役割を分けた。private は露出しないので従来どおり sweep なし・TTL 3日・枠消費ゼロ。

**やったこと**:

- **TTL を可視性で分けた**（public 60分・private 3日）。`publish-ephemeral` の `retention-days` は
  整数日で下限1日だったので、`retention-minutes` を新設した（正の整数のときだけ日側に勝つ。
  空・不正値は日側に fallback＝**タイポで TTL 0 になって読み中のスライスを消さない**方に倒す）。
- **sweep を日次→毎時**。掃除間隔がそのまま TTL の超過分になるので、TTL 60分に対して日次だと
  最大25時間残る。毎時なら上限 ≒ 2時間。
- **public では sweep が「1日より古い成功 run」を run ごと削除する**。本文をログから外しても
  run には `meta`（取得 URL・時刻）と dispatch 入力（`url`/`request_id`）が残り、これは結果ブランチの
  TTL の対象外で Artifact and log retention（ops-runner は7日設定）に従うため、public では
  TTL や cleanup で縮めた公開時間がログ側で無効になっていた。

**なぜ run_id の台帳を作らなかったか**（当初は「run 側が run_id を記録すればよい」と考えた）:
**Actions API が run 一覧そのものを持っている**ので記録は不要。`GET .../workflows/net-fetch.yml/runs
?status=success` を `created_at` で絞れば削除対象が出る。台帳をブランチに置くと、cleanup が
スライスを消したときに記録も消えて run が孤児になる順序問題も抱える。

**なぜログだけ削除（`DELETE .../runs/{id}/logs`）ではなく run ごと削除か**: 前者では run が残り、
**dispatch 入力の URL が見え続ける**ため目的を達しない。

**捨てたもの**: public では1日より後に「いつ何を取得したか」を遡れない（net-fetch は `ci-logs` に
publish しないので他に記録がない）。失敗 run は残すので障害調査は可能——retention 7日は
「エージェントのトークンが切れて後日調べる」ために設定されており、成功 run の削除はこれを損なわない。

**副作用（許容）**: `schedule` は workflow 単位でしか設定できず可視性で cron を分けられないので、
private consumer では毎時 skip の run が履歴に並ぶ（分数は 0）。

**権限**: `actions: write` は **sweep ジョブにだけ**与えた（job-level `permissions`）。
クリーンルームの fetch ジョブには渡さない。

**検討して却下した案**:
- **5分 cron** — GitHub の scheduled run は数十分遅延が常態で高負荷時には落とされるので、上限が名目だけになる。
- **run 内で `sleep` して自分で消す** — public なら無料だが run が `in_progress` のまま居座り、
  エージェントの読み取り合図（run completed）と衝突する。合図をジョブ単位に変える必要が出て、
  エージェントへの要求が増える。
- **遅延 cleanup run の自己 dispatch** — `GITHUB_TOKEN` 起点の `workflow_dispatch` は再帰防止で抑止され、
  PAT が必要になる。`consumers.txt` の「ops-runner に書き込み資格情報を置かない」に反する。
