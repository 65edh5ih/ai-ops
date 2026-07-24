## 2026-07-24 net-fetch: REST dispatch 例に必須 `ref` を明記（#74 follow-up）

#74（SOP ツール中立化）が REST dispatch 経路を新たに手順に載せたが、GitHub の workflow-dispatch REST
エンドポイント（`POST .../actions/workflows/{file}/dispatches`）は body に `ref` が**必須**なのに、step 4 は
`url`/`request_id` しか渡すよう書いておらず、**REST 経由のエージェントは 422 で run が作られず ci-logs スライスが
出ない**。マージ後の Codex レビュー（#74 の P2）が指摘。

#74 は既にマージ済みなので、マージ済みブランチに積まず**最新 main から貼り直して新規 PR** で follow-up
（マージ済み PR は再利用しない規約）。

対処: step 4 に「workflow を回す git ref は対象リポジトリの既定ブランチ（通常 `main`）」を明記し、
「REST を使うときは body に `ref` を必ず含める（無いと 422）」を追記。`gh workflow run` は未指定なら既定ブランチを
使うので省略可、MCP dispatch ツールは ref パラメータに既定ブランチを渡す、という手段差も添えた。

学び: ツール中立化で特定経路（REST）を手順に載せるなら、その経路の**必須パラメータを漏れなく**書く。
「どれでもよい」と選択肢を増やすときは、各選択肢が単独で完結する粒度まで書かないと、一番不便な経路
（生 REST）を選んだエージェントだけ静かに詰まる。
