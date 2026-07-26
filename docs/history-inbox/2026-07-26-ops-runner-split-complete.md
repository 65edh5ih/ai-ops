## 2026-07-26 net-fetch の実行を ops-runner へ移し、ai-ops から実行基盤を撤去（分離の第2段）

第1段（`consumers.txt` への追加）で ops-runner に配布が届いたのを確認し、runner 上で net-fetch を
実駆動（`status=ok` / http 200 / 結果ブランチのコミット数1）してから、ai-ops 側の実行用ファイルを撤去した。

### 撤去したもの / 残したもの

撤去: `.github/workflows/net-fetch.yml`・`.github/actions/net-fetch/`・`.github/actions/publish-ephemeral`（symlink）・
`.github/net-allowlist.txt`（symlink）・`.github/net-allowlist.local.txt`（中身はコメントのみで空だった）。

残した: `.github/actions/publish-ci-logs`（quota・archive・sync が使う）と control plane の6 workflow。
撤去後、残る workflow が参照するローカル action は `publish-ci-logs` だけであることを確認済み。

**`shared/` 側の正本は撤去していない**。ai-ops は引き続き net-fetch.yml と allowlist の**配布元**で、
実行しなくなっただけ。この区別を取り違えると配布が止まる。

### doc で「実行先」と「正本の場所」を分けて書く必要があった

`net-fetch.md` には ai-ops への言及が15箇所あったが、性質が3種類混在していた:

1. **集約モードの実行先** → `ops-runner` に変更
2. **allowlist の正本・共通ベースの編集先** → `ai-ops` のまま（`shared/` にある）
3. **Actions 月枠の信号の置き場** → `ai-ops` のまま（`ci-logs` の `quota/actions/actions.json`）

一括置換していたら 2 と 3 を壊していた。特に手順3の「共通ベースを直すなら ai-ops を参照して直接 PR」は、
step 2 でセッションに足す**実行先の ops-runner とは別リポジトリ**になったので、その旨を明記した
（同じ「セッションに足す」でも目的が違う2つが並ぶため、混同しやすい）。

### ai-ops の結果ブランチは掃除する主体が居なくなる

`net-fetch-results` は「取得のたび」と「日次 sweep」で失効するが、ai-ops から net-fetch を撤去すると
**どちらも走らなくなり、最後の結果が永久に残る**（揮発化の目的を裏切る）。削除が必要だが、
`git push --delete` は git プロキシに弾かれるためオーナー操作とした。**実行基盤を別リポジトリへ移すときは、
その基盤が生成していたブランチの後始末も同時に考える**（移設は「動かす場所を変える」だけでなく
「生成物の面倒を見る主体を移す」ことでもある）。
