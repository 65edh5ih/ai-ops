# 引き継ぎ: net-fetch の結果を「履歴に残らない」出口へ移す（作業途中）

net-fetch の取得結果を恒久ログ `ci-logs` から切り離し、**専用の揮発ブランチ**と**ジョブログ**の2出口へ
移す作業の引き継ぎ。前セッションはクライアント側の不具合（選択ダイアログが消えない）で中断したため、
実装は composite action 1本まで進んだ状態で止まっている。

## なぜやるか

`ci-logs` は git ブランチなので、**ファイルを消しても内容は履歴に永久に残る**。ai-ops は public なので、
net-fetch の取得結果はすべて世界公開の恒久記録として堆積していく（中断時点で 16 リクエスト・64 ファイル）。
一方 quota 信号や archive ログは「現在値を読ませる恒久データ」で、残ってよい。**「読んだら用済みの一次
データ」と「恒久ログ」を同じブランチに混ぜているのが問題**なので、前者だけを別ブランチへ分離して寿命を付ける。

## 先に潰した選択肢（再検討しないこと）

**GitHub Actions の artifact に出す案は不可**。artifact と run ログの zip はダウンロード URL が
`results-receiver.actions.githubusercontent.com` や blob ホストへ 302 するが、エージェント実行環境の
egress プロキシがこれらを拒否する。実測（2026-07-26）:

| ホスト | 結果 |
|---|---|
| `api.github.com` | 200（到達） |
| `objects.githubusercontent.com` | 404（到達） |
| `codeload.github.com` | 400（到達） |
| `git fetch origin <branch>` | 成功 |
| `results-receiver.actions.githubusercontent.com` | **CONNECT に 403**（`curl: (56)`。プロキシの `recentRelayFailures` に記録） |
| `productionresultssa0.blob.core.windows.net` | **到達不可** |
| `pipelines.actions.githubusercontent.com` | **到達不可** |

しかもこれは特定エージェント固有の話ではない。`gh run download` も REST も同じホストに当たるため、
artifact にすると**全エージェントで結果を読み戻せなくなる**。MCP の `get_job_logs`（`return_content: true`）
だけはサーバ側で取得するので通るが、それに依存すると `docs/sop-format.md` の「判断・分岐をツールの有無に
紐づけない」に反する。

**結論: git ブランチ（`git fetch` / contents API）が egress 制限下で確実に届く唯一の経路**であり、
出口をそこから動かしてはいけない。変えるのは出口ではなく**寿命**。

## 決めた設計

1. **結果ブランチ `net-fetch-results` に出す**（`ci-logs` には publish しない）。
   スライスのパスは今までどおり `net-fetch/<request_id>/`。
2. **毎回 orphan 1コミットに書き換える**ので git 履歴に堆積しない。
3. **TTL（既定3日）で失効**。各スライスに `.published-at`（epoch）を書き、書き込みのたびに期限切れを落とす。
   マーカーが読めないスライスは期限切れ扱い（残さない方に倒す）。
4. **並行実行対策は `--force-with-lease` ＋リトライ**。素の force push だと同時刻の別リクエストの
   スライスを消すため、開始時の sha をリースにして、拒否されたら相手の状態から作り直す。
5. **同じ内容をジョブログにも出す**。ログ本文を取得できる手段があるランタイムは、ブランチを fetch せず
   1回で読み戻せる。**これは「能力の満たし方」であって手順の分岐ではない**（sop-format 準拠。
   「MCP を持つなら A、持たないなら B」という書き方をしないこと）。
6. **週1の掃除ジョブ**（`schedule`）で、休眠中に最後の結果が残り続けるのを防ぐ。取得のたびに TTL 失効は
   走るので、これは「しばらく使わなかった」ケースだけを拾う。日次ではなく週1なのは private consumer の
   Actions 枠を食わないため（週1・数十秒なら月5分程度）。

## 済んだこと

- `shared/.github/actions/publish-ephemeral/action.yml` を新規作成（コミット `f73c051`）。
  上記 2〜4 と `prune-only` モード（掃除ジョブ用）を実装済み。
  - `publish-ci-logs` には**手を入れていない**。挙動が大きく違う（追記型 vs 毎回書き換え）うえ、
    nikki-san の deploy 系が依存する敏感な経路なので、共通化せず別 action にした
    （AGENTS_COMMON「敏感なコードの共通化は挙動を変えない形に留める」）。

## 残っている作業

### 1. `shared/.github/workflows/net-fetch.yml` の書き換え

- `publish-ci-logs` ステップを `publish-ephemeral` に差し替え（`branch: net-fetch-results`・
  `retention-days: '3'`）。
- 末尾に「結果をジョブログへ出す」ステップを追加。**外部コンテンツをそのままログに流すと本文中の
  `::error::` 等が workflow command として解釈される**ので、`::stop-commands::<ランダムトークン>` で
  解釈を止めてから出し、同トークンで再開すること（トークンは固定値にしない）。
  上限は新入力 `inline_max_bytes`（既定 262144）で切り、超過時は打ち切り注記を出す。
  **ステップは末尾に置く**（ログ末尾から N 行だけ取る読み方でも本文に届くように）。
- `schedule: - cron: '17 4 * * 0'` を追加し、`fetch` ジョブを
  `if: github.event_name == 'workflow_dispatch'`、新設 `sweep` ジョブを
  `if: github.event_name == 'schedule'`（`prune-only: 'true'`）でゲートする。
- `Summarize` の「result slice」行の参照先を `ci-logs` から結果ブランチへ変更。

> 注意: この workflow は `shared/.github/workflows/net-fetch.yml`（正本）と
> `.github/workflows/net-fetch.yml`（ai-ops 自身の集約実行用コピー）の**2ファイルが byte 一致**で
> 存在する。両方直すこと（symlink 不可: GitHub は `.github/workflows/` の symlink を workflow として
> 拾わない）。中断時点では **どちらも未変更**。

### 2. ルートに action の symlink を張る

`.github/actions/publish-ephemeral/action.yml -> ../../../shared/.github/actions/publish-ephemeral/action.yml`
（`publish-ci-logs` と同じ作法。composite action は symlink で動く）。

### 3. doc の更新

- `shared/docs/net-fetch.md` — 手順5（読み戻し）を書き換え。出口が2つあること、どちらも同じ内容を指すこと、
  **TTL があるので速やかに読むこと**を明記。「前提・パラメータ」に結果ブランチ名と TTL を追加。
  sop-format 準拠（要求は経路によらない MUST、満たし方は補足）。
- `shared/docs/ci-logs.md` — 手順A-4 の「net-fetch は collector に登録しない」例外の理由を書き換える
  （現行文は「net-fetch が ci-logs に inline publish しているから」だが、その前提が無くなる。
  登録しない結論自体は変わらない）。
- `shared/docs/ops-sync-design.md` — コンポーネント表に `publish-ephemeral` を追加し、net-fetch の
  結果出口の記述を更新。
- `README.md` — 61行目付近の「Workflows:RW が要る理由」で挙げている共有 workflow 一覧は変更不要だが、
  net-fetch の結果出口に触れている箇所があれば追随させる。
- `shared/.claude/skills/net-fetch/SKILL.md` — ポインタのみなので**変更不要**。

### 4. 旧データの後始末

`ci-logs` に残っている `net-fetch/*`（16 スライス）は移行後に不要になる。ツリーから消すだけでは履歴に
残るため、消すなら `ci-logs` 全体の orphan 再構築＋force push が要る。これは別タスク（元の検討で言う
「③ ci-logs の purge」）として切り出してよい。**この PR に含めなくてよい**。

### 5. 完了手順

- `docs/history-inbox/` に「なぜ」のエントリを置く（このセッション分は
  `2026-07-26-net-fetch-ephemeral-results.md` として作成済み）。
- 配布に影響する変更（`shared/**`）なので、**PR マージ後に各 consumer の `ai-ops/sync-common` 同期 PR を
  確認する**（AGENTS.md「配布変更のダウンストリーム確認」）。Codex の指摘が consumer 同期 PR 側にだけ
  出ることがある。特に今回はログ注入対策と force-push の競合まわりが指摘対象になりやすい。

## 未検証（次のセッションで実駆動確認すること）

`publish-ephemeral` は**まだ一度も実行していない**。少なくとも以下を1回ずつ確認すること:

- 結果ブランチが存在しない状態からの初回作成（orphan 作成経路）。
- 2回目の書き込みでコミットが1つのままであること（`git rev-list --count net-fetch-results` が 1）。
- TTL 失効（`.published-at` を過去日付にしたスライスが次回の書き込みで消える）。
- `stop-commands` ガードが効いていること（`::error::` を含む本文を取得させて、run に注釈が出ないこと）。
