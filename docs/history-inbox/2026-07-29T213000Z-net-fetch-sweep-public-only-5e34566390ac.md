## 2026-07-29 net-fetch の日次 sweep を public 限定にする

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
