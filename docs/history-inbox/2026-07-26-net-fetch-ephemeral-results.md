## 2026-07-26 net-fetch の結果を揮発ブランチへ移す（作業途中・引き継ぎあり）

ai-ops をゼロベースで設計し直すなら機能分離すべきか、という相談から派生した作業。net-fetch の取得結果が
public な ai-ops の `ci-logs` に**恒久堆積**している（中断時点で 16 リクエスト・64 ファイル）のを、
専用の揮発ブランチ `net-fetch-results` へ分離して TTL を付ける。**未完**——残作業は
`docs/reference/NET_FETCH_EPHEMERAL_HANDOFF.md` に全部書いた。

### 「artifact に出す」案を実測で潰した

当初 artifact（`retention-days` で自動失効）を推した。これは**間違いで、実測で潰れた**。artifact と run
ログの zip はダウンロード URL が `results-receiver.actions.githubusercontent.com` や blob ホストへ 302 するが、
エージェント実行環境の egress プロキシがそれを拒否する（`curl: (56) CONNECT tunnel failed, response 403`。
プロキシの `recentRelayFailures` にも記録された）。`productionresultssa0.blob.core.windows.net` と
`pipelines.actions.githubusercontent.com` も到達不可。一方 `api.github.com`・`objects.githubusercontent.com`・
`codeload.github.com`・`git fetch` は通る。

しかもこれは特定エージェント固有ではない。`gh run download` も REST も同じホストに当たるので、artifact に
すると**全エージェントで結果を読み戻せなくなる**。MCP の `get_job_logs` だけはサーバ側取得なので通るが、
それに依存すると sop-format の「判断・分岐をツールの有無に紐づけない」に反する。

**学び: `ci-logs` がブランチ方式なのは正解だった**（git と `api.github.com` が egress 制限下で確実に届く
唯一の経路）。出口を動かすのではなく寿命を付けるのが正しい。**設計を変える前に到達性を1回測る**——
測らずに実装していたら net-fetch を全エージェントで壊していた。

### 恒久ログと一次データを同じブランチに混ぜていたのが根因

`ci-logs` は「消しても履歴に残る」ので、public リポジトリでは削除が削除にならない。quota 信号や archive
ログは**現在値を読ませる恒久データ**で残ってよいが、net-fetch の結果は**読んだら用済みの一次データ**。
この2種類を同居させたまま purge しようとすると、恒久側の履歴まで巻き込む。分離してブランチごと
使い捨てにするのが正しい切り分け。

### `publish-ci-logs` を拡張せず別 action にした

`publish-ephemeral` は挙動が大きく違う（追記型 vs 毎回 orphan 書き換え・TTL 失効・force-with-lease）うえ、
`publish-ci-logs` は nikki-san の deploy 系が依存する敏感な経路。AGENTS_COMMON の「敏感なコードの共通化は
挙動を変えない形に留める」に従い、共通化せず新規に分けた。

### 並行実行で他人のスライスを消さない

毎回 orphan で force push する設計なので、素の force だと同時刻の別リクエストの結果を消す。開始時の sha を
`--force-with-lease` のリースにして、拒否されたら相手の状態から作り直す（相手のスライスが生き残る）。

### 外部コンテンツをジョブログに出すときの注入

MCP 等でログ本文を読めるランタイム向けに、結果をジョブログにも出す方針にした。ただし**取得した外部
コンテンツをそのまま出すと本文中の `::error::` 等が workflow command として解釈される**。
`::stop-commands::<ランダムトークン>` で解釈を止めてから出す（トークンを固定値にすると本文側から
推測して止め損なえるのでランダム）。

なお「MCP を持つエージェントはログから、持たないものはブランチから」という書き方は sop-format 違反。
**要求（結果を読み戻す）は経路によらず1つ**で、ログとブランチは「満たし方」の補足として書く。

### セッション中断について

クライアント側の不具合で選択ダイアログ（AskUserQuestion）が消えなくなり、作業継続が不能になった。
実装は composite action 1本まで。**中断時点で既存ファイルは1つも変更していない**ので、残作業は
引き継ぎ doc からそのまま再開できる。

### アクセスした外部 URL

到達性検証のみ: `results-receiver.actions.githubusercontent.com`（403）・
`productionresultssa0.blob.core.windows.net`（到達不可）・`pipelines.actions.githubusercontent.com`（到達不可）・
`api.github.com`・`objects.githubusercontent.com`・`codeload.github.com`（到達確認）。
