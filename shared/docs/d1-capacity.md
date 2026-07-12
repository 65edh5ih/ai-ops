# D1 の容量管理（全リポジトリ共通）

## 目的

Cloudflare D1 の容量上限は**アカウント内「全 D1 データベースの合計」**で 5GB。複数リポジトリ・
複数 Worker が同一アカウントの D1 を使うため、容量は**リポジトリ横断**で気にする必要がある。
この doc は、その制約と、各 DB を上限内に保つ retention 実装のノウハウ（特に実測で判明した
ハマりどころ）を1か所に集約する。

## いつ使うか（トリガ）

- 新しい D1 データベースを作る / 既存 D1 に定常的な書き込み（ログ等）を足すとき。
- D1 の容量・retention（古い行の削除）を設計・実装・レビューするとき。
- 「D1 が一杯になったらどうなるか」を確認するとき。

## 前提: D1 無料枠（Cloudflare 公式・2026-07 時点）

- ストレージ: **5GB（アカウント内全 D1 の合計。テーブルも索引も加算）**
- 書き込み: 10万 rows_written/日（**INSERT・UPDATE・DELETE すべて**が rows_written に加算）
- 読み取り: 500万 rows_read/日
- 日次リセット 00:00 UTC。egress 課金なし。
- 超過時のエラー文言（参考）: `Exceeded maximum DB size.`（単一 DB）/
  `Your account has exceeded D1's maximum account storage limit ...`（アカウント合計）。

## 容量の測り方

- **アカウント合計**: Cloudflare MCP / API の `d1_databases_list` が全 DB の `file_size`（バイト）を
  1回で返す → 合計する。これが正（DB 一覧をハードコードしない）。API 側（cron / エージェント）
  からのみ取得できる。
- **単一 DB の現在サイズ**: 全 D1 クエリ結果の `meta.size_after`（バイト）。Worker / Pages Function
  内から**自 DB のサイズだけ**が追加コストなしで取れる（他 DB・アカウント合計は関数内からは見えない）。

## 各 DB を自分で上限内に保つ（行数リングバッファ）

5GB はアカウント共有なので、各 DB は自分の取り分を自己管理する（SHOULD: 単一 DB を 1GB 未満など、
明示した目標に収める）。定常書き込みするログ系テーブルは、最新 N 行だけ残すリングバッファに
するのが素直。実装の要点:

1. **MUST: 削除の判定は「バイトサイズ」でなく「行数」で行う。** SQLite(D1) は DELETE しても
   ファイルサイズがすぐ縮まない（空きページは以後の INSERT で再利用されるが `file_size` /
   `meta.size_after` は高止まりする）。バイト超過をトリガーに削除すると、削除してもサイズが
   下がって見えず**毎回削除が走って暴走する**。行数なら削除で確実に減る。
2. **MUST NOT: `OFFSET` で「N 行目」を数えて削除しない。** `... ORDER BY id DESC LIMIT 1 OFFSET N`
   型のサブクエリは行数に比例してテーブルをほぼ全スキャンし、1 挿入あたりの `rows_read` が
   肥大化して 500万/日の読み取り上限を数年で食い潰す。
3. **SHOULD: INSERT の `meta.last_row_id` を使い id 範囲で直接削除する。**
   `DELETE FROM <table> WHERE id <= (last_row_id − MAX_ROWS)`。索引で O(削除行数)・全スキャンなし。
   テーブルは AUTOINCREMENT の整数主キーを持つこと（無ければ rowid か時刻列で代替）。
4. **MUST: DELETE も rows_written に加算されることを踏まえ、刈り込みは「窓から外れた分だけ」に
   留める。** 上限付近で毎挿入ごとに大量削除すると 10万/日の書き込み上限に当たる。id 範囲方式なら
   steady state で1挿入あたり数行の削除で済む。
5. **SHOULD: MAX_ROWS は実効バイト/行から安全側に決め、`size_after` をログして較正する。**
   1行の実効バイトは列の内容＋**索引の本数**で増える（索引1本ごとに加算）。到達時に実測して
   MAX_ROWS を調整する。

参照実装（同型・そのままひな形にできる）:

- `nikki-san`: `functions/api/view.js` の `trimOldRows`（アクセスログ・100万行）
- `private`: `cloudflare_workers/shared/logger.js` の `trimEmailLogs`（メールログ・100万行）

## 満杯にしたときの挙動（対策しない場合）

上限に達すると以降の INSERT が失敗し、その書き込みは失われる（＝最新が捨てられ、古い行は残る）。
リングバッファ（最新 N 行維持）は逆に「古い行から捨てて最新を守る」。どちらもデータ喪失は不可避で、
**何を残したいか**で選ぶ。

## よくある失敗

- **バイトサイズをトリガーにして削除ループが暴走**（no-shrink を見落とす）。→ 行数で判定する（上記 MUST）。
- **`OFFSET N` の刈り込みで読み取り上限に静かに突入**し、ある日から書き込みが `catch` されて記録が
  止まる。→ id 範囲削除にする（上記 MUST NOT / SHOULD）。
