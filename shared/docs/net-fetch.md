# net-fetch: エージェントの代理インターネット取得（GitHub Actions リレー）

egress 制限下のエージェントが、GitHub Actions ランナー（フルのネット接続を持つ）を中継して
**許可ドメインだけ**を取得するための手順。secret を一切ジョブに渡さないクリーンルームで実行し、
allowlist・SSRF ガード・secret スキャンを workflow 側で enforce する。

## いつ使うか（トリガ）

- セッションの egress 制限で目的の URL に直接到達できず（403/407 等）、その取得が作業に必要なとき。
- 対象は「**認証不要で公開取得してよいリソース**」に限る（API キーや Cookie が要る取得はこのリレーの対象外
  ——クリーンルームは secret を持てない）。
- パッケージ取得（npm/PyPI 等）・git/GitHub 操作・設定済み MCP 経由の通信には使わない（元から通る）。

## 前提・パラメータ

- **取得先ドメインが allowlist にあること**。allowlist は2層の union:
  - 共通ベース: `.github/net-allowlist.txt`（ai-ops が全リポジトリへ配布。**public な ai-ops にも置かれ、
    集約モードの判定に使われる**ため、機微を取得しうるドメインは**書かない**）。
  - リポジトリ固有: `.github/net-allowlist.local.txt`（各リポジトリが自分で持つ・配布対象外・任意）。
    **機微を取得しうるドメインはここ（private リポジトリのローカル）にだけ書く**。
  - 記法: 1行1ホスト。完全一致か `*.example.com`（サブドメインのみ・素の `example.com` には不一致）。
- **`<request_id>`**: `[A-Za-z0-9._-]+`。結果スライスのパスになる。取得ごとに一意にする（衝突回避）。
- **実行リポジトリの選択（モード）**——どちらで起動するかで可視性と枠消費が決まる:
  - **集約**: public な **ai-ops** で起動する。GitHub Actions 分は無料。ただし**結果は ai-ops の `ci-logs`
    ブランチ＝世界公開**に落ちる。→ public に晒してよい取得のみ。共通ベース allowlist だけが効くので、
    機微ドメインは構造的にここを通れない。
  - **分散**: 作業中の **private リポジトリ自身**で起動する。結果はそのリポジトリの `ci-logs`（非公開）に留まる。
    共通∪固有 allowlist が効くので機微ドメインも取得できる。private リポジトリの月枠を消費する。
  - 現状の既定は **集約**（枠が逼迫しているため）。public に晒せない取得だけ分散にする。
    枠残量による集約/分散の自動選択（quota-gate）は将来の共通基盤で足す（この手順・workflow は変更不要）。

## 手順

1. **モードと実行リポジトリを決める**（上記）。集約なら対象は `65edh5ih/ai-ops`、分散なら作業中リポジトリ。
2. **集約モードで ai-ops を使うなら、セッションに ai-ops を追加する**。エージェント起点で勝手に追加しない
   （MUST NOT）——ユーザーに「`65edh5ih/ai-ops` をこのセッションに追加して取得に使いますか？」と
   はい/いいえで確認し、承諾を得てから `add_repo` する（→ `docs/cross-repo-tasks.md` と同じ作法）。
3. **取得先が allowlist に無ければ、先に足す**。共通ベースへ足すのは ai-ops 側の変更なので outbox 提案
   （`種別: shared-file` で `shared/.github/net-allowlist.txt`。→ `docs/outbox-proposal.md`）。固有は対象
   リポジトリの `.github/net-allowlist.local.txt` を直接編集。**public リポジトリの固有 allowlist にも機微
   ドメインを書かない**（public で実行すれば結果は公開に落ちる。MUST NOT）。
4. **workflow を起動する**。対象リポジトリの `net-fetch` workflow を `workflow_dispatch` で、
   `url` と一意の `request_id` を渡して実行する（`method` 既定 GET）。エージェントは自前の GitHub 資格情報で
   dispatch する（consumer 側に dispatch 用トークンを置かない＝ルール正本への増幅経路を作らない）。
   - 完了条件: run が completed になる。ジョブは allowlist 外や secret 検出でも**失敗しない**（弾いた事実を
     結果に残して緑で終わる）。赤で終わるのはインフラ的 error のときだけ。
5. **結果を読み戻す**。実行したリポジトリの **`ci-logs` ブランチ**の `net-fetch/<request_id>/` を読む:
   - `status.txt` … 1行目が `ok` / `rejected` / `error`（rejected は2行目に理由）。
   - `response.txt` … 取得本文（secret は伏字済み。`ok` のときのみ）。
   - `meta.txt` … url・http ステータス・生成時刻。
   - 完了条件: `status.txt` が `ok` で `response.txt` に本文がある。`rejected` なら理由に従い allowlist 追加
     などをして `request_id` を変えて再実行する。

## 縛り（この仕組みが構造的に保証すること）

- **secret を fetch に含められない**: 取得ステップの env に secret を一切載せない（クリーンルーム）。
  加えて request（URL・クエリ）に secret パターンや `token=`/`access_token=` 等が現れたら**送信前に拒否**、
  応答本文・ヘッダに現れた secret パターンは**publish 前に伏字**。認証が要る取得は原理的に通らない。
- **allowlist 外へ行けない**: ホスト完全一致か `*.suffix` のみ許可。https 以外・URL 内資格情報・IP リテラル・
  `localhost`・クラウドメタデータ（`169.254.169.254` 等）は allowlist と無関係に常に拒否。リダイレクト追従は
  無効（非許可先への 302 迂回を防ぐ）。
- **機微は public 経路を通れない**: 集約モードの判定は共通ベース allowlist のみ。機微ドメインはそこに無い
  ため、機微取得は private リポジトリの分散モードでしか成立しない（配置がルールを強制する）。

## よくある失敗

- （まだ無し。実際に起きたら追記する。）
