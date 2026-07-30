## 2026-07-29 net-fetch の掃除を定期 sweep 依存から「読了後の cleanup dispatch」へ移す

consumer（nikki-san）で「net-fetch ジョブが落ちている」を調査していて見つけた、配布物側の設計の歪み。

**なぜ変えたか**: 日次 sweep の根拠は `net-fetch.yml` のコメントどおり「集約モードは public なので、
TTL を超えて世界公開する時間を最小化する」こと。この便益は public な ops-runner でしか発生しないのに、
同じファイルが private consumer（nikki-san / private）へ無改変で配られ、そこでは**結果が非公開＝便益ゼロ
なのに Actions 分数だけがアカウント単位の月枠に課金される**状態だった。nikki-san では
`net-fetch-results` ブランチが一度も存在せず、掃除対象ゼロの空振りを毎日スケジュールしていた。

**なぜ repo variable でなく `github.event.repository.private` で分けたか**: 判定軸が
「結果が世界公開されるか」＝リポジトリの可視性そのものなので、可視性を直接読めば consumer 側の
設定作業がゼロで済み、variable の設定漏れによる drift も起きない。

**捨てたもの（意図的なトレードオフ）**: private の保持期間の上限。`publish-ephemeral` は
`prune-only` でなくても同じ失効ロジックを通るので掃除機能自体は残るが、契機が「次の取得」だけになり、
休眠中は最後のスライスが**次に net-fetch を使うまで**残る（上限なし）。非公開なので世界公開には
ならないという判断。この事実は3箇所（`shared/docs/net-fetch.md`・`shared/docs/ops-sync-design.md`・
`README.md`）に書かれていたので全部モード別に書き分けた——**片方だけ直すと「3日で消える」を
private で当てにする読み手が出る**。

**やらなかったこと**: 枠切れ自体の対処。sweep の失敗（nikki-san で 07-27〜07-29 の3 run、いずれも
`runner_id: 0`・`total_ms: 0` のランナー割り当て拒否）は**枠を消費した原因ではなく結果**で、sweep は
一度も成功していない＝1分も課金されていない。枠の実数確認は billing 画面が正本。この PR は枠の
復旧策ではなく、上記の「効かない保証のために枠を払う」構造だけを直すもの。

### レビューで設計を差し替えた（当初案 → 最終案）

当初は上の「public 限定ゲート」だけだったが、ユーザー指摘で**定期 sweep 自体が最善でない**と分かり
2点を追加した。判断の軸は「定期実行は使わない月も課金されるが、後片付けは使ったときだけでよい」。

- **読了後の cleanup dispatch を主経路にした**（`cleanup: 'true'` 入力＋`cleanup` ジョブ、
  `publish-ephemeral` に `drop-slice` 入力を追加）。公開時間が TTL の3日から実際の読み取り時間
  （数分）に縮み、かつ休眠中の課金がゼロになる。日次 sweep は「dispatch をし損ねたとき」の
  バックストップに格下げ（public のみ）。
  - **エージェント自身にブランチを消させるのは却下**: doc が要求している能力は結果の読み取りだけで、
    ops-runner は「書き込み権限を持つ資格情報を置かない」方針（`consumers.txt`）。`add_repo` の
    read 権限でも push できない。dispatch なら既に持っている `actions:write` で足りる。
  - **「5分後に消す」も却下**: 同一ジョブで `sleep 300` すると1取得あたり5分課金で日次 sweep より高い。
    別 cron にすると高頻度 sweep そのもので、しかも GitHub の scheduled run は数十分遅延が常態。
- **応答本文をジョブログに出すのをやめた**（meta＋`bytes`/`sha256` だけに）。ログは git ブランチでは
  ないので TTL が効かず、Artifact and log retention（ops-runner は7日設定）に従って残る——public では
  world-readable のままで、**TTL や cleanup で縮めた公開時間がログ側で無効になっていた**。
  - 併載の元の理由は「ブランチを fetch できないランタイムのため」と読めたが、**実際は往復回数の
    削減にすぎなかった**（doc 自身が読み方に「コンテンツ取得 API」を挙げている＝dispatch できる
    権限があればブランチも読める）。能力の橋渡しではなかったので、落として失うものは無い。
  - retention を1日に下げる案は採らない: ユーザーが Actions のエラー調査用に7日で運用している
    （エージェントのトークンが切れて後日調べる場合に備える）。本文を出さなければ retention は
    長くても無害なので、そちらを維持する。
- **private は TTL 3日のまま**（全消しにしない）。非公開で露出しないため、抑えたいのは Actions 消費だけ。
