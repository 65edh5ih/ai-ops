## 2026-07-31 collect-outbox のチェックアウトを役割で分ける（dispatch 事故の同型を塞ぐ）

- `archive-task-history` で踏んだ「feature ブランチから dispatch すると、そのブランチの差分が
  `base: main` の PR に乗って自動マージされる」の同型が `collect-outbox` にも残っていた。
  こちらは `Checkout ops-sync` 1つが **script source と取り込み PR の作業ツリーを兼ねていた**ため、
  ブランチから dispatch すると intake PR にブランチの差分が乗る。提案が無いと PR 自体が立たないので
  実害は出ていなかった（＝踏まなかっただけで、条件が揃えば同じことが起きる）。
- 直し方は「**1つの checkout に2つの役割を持たせない**」。
  - `ops-sync-src`（ref 省略＝workflow の ref）… スクリプトとローカル action。**ブランチから dispatch して
    マージ前に検証できる**のはこの側が workflow の ref を取るからで、これは意図した動作なので残す。
  - `ops-sync`（`ref: main`）… 書き換えて取り込み PR にする木。PR の base と一致させる。
  - `ops-sync-prune`（`ref: main`）… トゥームストーン掃除 PR の木。同じ理由。
- `AGENTS_COMMON.md` と `consumers.txt` の読み取りは**書き換える木の側**（main）から行う。これらは
  「動かすコード」ではなく**正本のデータ**で、提案の適用対象そのものだから。`ref` を役割で分けるとき、
  この「コードかデータか」の切り分けを間違えるとブランチのデータに対して提案を適用してしまう。
- 設計 doc に「『動かすコード』と『書き換える木』の ref を分ける」節を足した。自分自身を巡回対象に
  含む cross-repo バッチ全部に効く不変条件で、インラインコメントだけだと次に workflow を足す人が
  同じ穴を作る。
