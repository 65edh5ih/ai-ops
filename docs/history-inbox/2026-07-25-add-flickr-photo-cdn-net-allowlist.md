## 2026-07-25 net-fetch共通allowlistにFlickr写真CDNを追加

nikki-san で Flickr移行写真の `_o`/`_z` 実サンプルをnet-fetch経由で取得し、JPEG圧縮パラメータ
（Flickrの縮小版生成クオリティ）を調査する必要が生じた。取得先の `live.staticflickr.com`・`filedn.eu`
はどちらも不特定多数のユーザーの公開コンテンツを配信する汎用CDNで、ドメイン自体に個人性は無い
（取得する特定のURLが個人の写真を指すだけ）ため、機微ドメイン判定の対象外とし共通ベースに追加した。

判断根拠の整理: allowlistの共通/固有区分は「そのドメインが一般に機微データを扱うか」で決めるべきで、
「今回取得したい個々のコンテンツが機微か」で決めるべきではない（後者は実行モード＝集約/分散の判断軸）。
当初これを混同し、nikki-sanのローカルallowlistに追加しようとして手戻りになった。

副産物として、net-fetch.md の「共通ベースへの追加」手順が、consumer から出す outbox 提案（非同期・
collect cron待ち）と、`add_repo` を持つエージェントが ai-ops を直接編集する経路のどちらを使うべきか
明示していなかったため誤って前者を選んだ。手順に優先順位を明記する修正を別途 shared-file として本PRに
含めた。

さらにユーザーから、ドメインの機微性とは別に GitHub Actions の月枠逼迫がある指摘を受けた。枠残量その
ものを直接取得する手段は無い（billing API はPAT必須・アカウント単位・遅延あり）が、ユーザーの再指摘で
「間接判定は可能」と気付いた: このアカウントの consumer リポジトリは枠逼迫時にdeployをCloudflare側へ
手動退避する repo variable を運用しており（nikki-sanの`PAUSE_GH_DEPLOY`/`PAUSE_ADMIN_WORKER_DEPLOY`）、
変数の値を直接読めなくても、対象repoのpush起点deploy workflowの直近runがconclusion=skipped続きなら
「枠逼迫で退避中」と判定できる（`list_workflow_runs`で取得可能・追加の資格情報不要）。実際に nikki-san
の`deploy.yml`を確認したところ直近複数runが軒並みskippedで、現在まさに逼迫中と確認できた。同一
アカウント配下の他privateリポジトリもActions枠を共有するため、この判定は分散モードの可否判断に転用
できる。net-fetch.md に「間接判定をまず試み、それでも確信が持てなければユーザーに確認する」形で追記した
（判定できないリポジトリでは引き続きユーザー確認が必須）。quota-gateの自動化自体は今後の課題として残る。
