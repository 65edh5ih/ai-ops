# ops-sync

AIエージェント（Codex / Claude Code / Gemini CLI / Qwen Code / Kimi Code CLI / OpenHands / GitHub Copilot /
Continue / Cursor / Cline / Windsurf / Antigravity）向けの
**全リポジトリ共通の運用ルール・共通インフラ・
リポジトリ横断タスクの単一の正（source of truth）**。ここで1回直せば、CI が各 consumer リポジトリへ
同期PRを自動生成する（設定により自動マージまで）。手動リレー（外部ツールへのコピペ等）を不要にするのが目的。

- **設計の全体像（なぜこうなっているか）**: [`shared/docs/ops-sync-design.md`](shared/docs/ops-sync-design.md)（consumer では `docs/ops-sync-design.md` として配置）
- **このリポジトリで作業するエージェント向けの指示・置き場所の判断ルール**: [`AGENTS.md`](AGENTS.md)
- 以下は運用手順（how）。

## なぜ「同期（コピーを各リポジトリに置く）」なのか

エージェントは原則1セッション1リポジトリしか見えず、兄弟リポジトリのメモリ（AGENTS.md/CLAUDE.md）は
自動ロードされない（例外は [`shared/docs/ops-sync-design.md`](shared/docs/ops-sync-design.md)
「前提・限界」のマルチリポジトリセッションの項）。
したがって「全リポジトリの AI に同じ共通ルールを確実に効かせる」唯一堅牢な方法は、
**共通ルールを各リポジトリの AGENTS.md に物理的に存在させる**こと。その配布を自動化するのが本リポジトリ。

エージェントごとに入口ファイルが違う（Codex=`AGENTS.md`、Claude Code=`CLAUDE.md`、Gemini CLI=`GEMINI.md`）が、
`CLAUDE.md` / `GEMINI.md` を `AGENTS.md` への symlink にすれば**全エージェントが同じ AGENTS.md を読む**。この
入口 symlink は sync が各 consumer に自動配線する（`scripts/apply-entrypoints.mjs`）ので、正本はプレーンな
`AGENTS.md` 一本でよい（plugin / hook に依存しない＝エージェント非依存）。OpenHands V0 だけは AGENTS.md を
既定で読まないため、`shared/.openhands/microagents/repo.md`（AGENTS.md へのポインタ）で誘導する。GitHub Copilot
（`.github/copilot-instructions.md`）・Continue（`.continue/rules/ops-sync.md`）・Cursor（`.cursor/rules/ops-sync.mdc`）・
Cline（`.clinerules/ops-sync.md`）・Windsurf（`.windsurf/rules/ops-sync.md`）も同様に、`shared/` 配布の固定内容
ポインタから AGENTS.md へ誘導する（入口が実ファイルなので symlink 配線は不要）。Codex / Kimi Code CLI /
Qwen Code / Antigravity は `AGENTS.md` をネイティブに読む（Qwen は既定の `QWEN.md` に加え AGENTS.md も読むため
入口 symlink を張ると二重ロードになる＝張らない。ただし `.qwen/skills/` の skill ミラーは配る）ため、
**追加配線なしで対応済み**（詳細は `shared/docs/ops-sync-design.md`「前提・限界」のエージェント別入口一覧）。

## 構成

| ファイル | 役割 |
|---|---|
| `AGENTS.md` | ops-sync で作業するエージェント向けの指示・置き場所の判断ルール |
| `shared/docs/ops-sync-design.md` | 仕組みの設計ドキュメント（アーキテクチャ・判断根拠） |
| `AGENTS_COMMON.md` | 共通ルール本体（**ここだけを編集する**） |
| `shared/**` | （下り）consumer へ配布する実ファイル・共通 doc。consumer のパスをミラー |
| `tasks/<owner>/<repo>/` | （下り）その consumer 宛のリポジトリ横断タスク（→ `shared/docs/cross-repo-tasks.md`） |
| `sync-deletions.txt` | （下り）consumer から撤去する unmanaged ファイルの一覧 |
| `consumers.txt` | 配布先リポジトリ（`owner/repo` を1行ずつ）。作業リポジトリ（private）に加え、計算基盤 `ops-runner`（public）もここに載る |
| `scripts/apply-common.mjs` | （下り）consumer の AGENTS.md のマーカー区間へ反映（無ければ追記） |
| `scripts/apply-entrypoints.mjs` | （下り）consumer に `CLAUDE.md` / `GEMINI.md` → `AGENTS.md` の入口 symlink を配線 |
| `scripts/apply-shared.mjs` | （下り）`shared/**`・`tasks/**` の配置（正本の実行ビットを保持）と、manifest 差分による削除の伝播、skill ミラーの自動生成 |
| `shared/scripts/new-task-history.mjs` | （下り）時刻＋ランダムIDで衝突しないタスク履歴フラグメントを排他的に新規作成する共通スクリプト |
| `scripts/new-task-history.mjs` | ops-sync自身が上記正本をconsumerと同じパスで使うためのsymlink |
| `.github/workflows/sync.yml` | （下り）変更時＋cron（1日1回の再適用＝手編集ドリフトの自己修復）で各 consumer へ同期PRを自動生成（MERGE_MODE で自動マージ可） |
| `scripts/collect-outbox.mjs` | （上り）consumer の `.ops-sync/outbox/*.md` 提案を種別に応じて反映（1 consumer 分をまとめて処理・不正な提案は `rejected/` へ差し戻し） |
| `.github/workflows/collect-outbox.yml` | （上り）cron（約6時間ごと）＋手動で提案を拾い、取り込みPR＋掃除PRを生成。あわせてトゥームストーン掃除。処理ログは提案元 consumer の `ci-logs` へ、ops-sync には件数だけ |
| `scripts/archive-task-history.mjs` | （保守）`docs/history-inbox/` のフラグメントを本体へ統合し、保持量超過分を `docs/history-archive/` へ移す |
| `.github/workflows/archive-task-history.yml` | （保守）cron（1日1回）で ops-sync＋全 consumer を巡回し、未統合フラグメント／超過分の統合＋アーカイブPRを生成・マージ。処理ログは対象リポジトリの `ci-logs` へ、ops-sync には件数だけ |
| `scripts/prune-tombstones.mjs` | （保守）`sync-deletions.txt` の役目を終えた行（全 consumer で削除済み）を自動で刈る |
| `scripts/actions-quota.mjs` | （信号）billing API で Actions 月枠の使用率を測り、`ok`/`tight`/`exhausted`/`unknown` の粗い state に落とす |
| `.github/workflows/actions-quota.yml` | （信号）cron（6時間ごと）で上記を実行し `ci-logs` の `quota/actions/actions.json` へ publish。エージェントが private repo で workflow を回してよいかの判断に使う（手順: `shared/docs/actions-quota.md`） |
| `scripts/codex-review-inbox.mjs` | （信号）全リポジトリの PR から未 resolve の Codex レビュースレッドを集め、全体一覧＋リポジトリごとのスライスに落とす |
| `.github/workflows/codex-review-inbox.yml` | （信号）cron（毎時）＋手動で上記を実行し、全体一覧を private の `.ops-sync/codex-review-inbox-all.md`、private consumer の自分の分を `.ops-sync/codex-review-inbox.md` へ push（変化があるときだけ）。public repo は全体一覧だけ |
| `scripts/cloudflare-quota.mjs` | （信号）CF の月枠（Pages のビルド回数・Workers Builds の分数）を測り、使用率と**直近レートによる月末予測**の両方で band を出す |
| `.github/workflows/cloudflare-quota.yml` | （信号）cron（6時間ごと）で上記を実行し `ci-logs` の `quota/cloudflare/cloudflare.json` へ publish。GitHub 枠の逼迫時に「CF へ退避してよいか」の判断に使う |

## 実行基盤（ops-runner）

**エージェントが dispatch する計算は ops-sync では動かさない。** 専用の consumer
**`65edh5ih/ops-runner`（public）**で動かす。現状の対象は net-fetch（集約モード）で、
その workflow・allowlist・共通ルールは通常の配布でここへ届く（runner 側に固有の配線は無い）。

- **境界の判定は「`OPS_SYNC_TOKEN` が要るか」**。要るもの（sync / collect-outbox / archive /
  branch-cleanup）と、外部入力を取らない cron（quota 信号）は ops-sync。エージェントが任意に起動し、
  外部 URL の中身を持ち込むものは ops-runner。→ `shared/docs/ops-sync-design.md`「実行基盤の分離」
- **ops-runner は public 必須**。無料枠で回すため（private だとアカウント単位の Actions 枠を消費する）。
  帰結として、配布物も net-fetch の取得結果も**世界公開**になる。機微を取得しうるものは集約モードに
  流さない（分散モード＝作業中の private リポジトリで実行する。→ `shared/docs/net-fetch.md`）。
- **ops-runner に secret を置かない**（`github.token` のみ）。これが分離の目的そのもの。
- 集約モードの dispatch 先・結果の読み戻し先はどちらも ops-runner。ただし **allowlist の正本は ops-sync の
  `shared/.github/net-allowlist.txt`**、**Actions 月枠の信号は ops-sync の `ci-logs`** で、これらは移っていない。
- net-fetch の揮発結果は `publish-ephemeral` が既定3日で掃除する。`slice-root` 直下で `.published-at` が無い・
  読めないスライスも安全側に削除し、最後のスライスが失効した場合は空 tree を publish するため、marker の
  欠落や空ブランチ化を理由に古い結果が残り続けることはない。ただし公開時間を縮める主経路は TTL ではなく
  **エージェントが読了後に投げる cleanup dispatch**（`cleanup: 'true'`）で、これを省くと TTL いっぱい残る。
  **日次 sweep は取りこぼし用のバックストップで public リポジトリのみ**（private では枠を使わないため skip。
  private の休眠中は次の取得まで残るので「3日で消える」を当てにしない）。応答本文はジョブログには出さない
  （ログは TTL が効かず retention 設定に従うため。ログには meta と `bytes`/`sha256` だけ）。
  → `shared/docs/net-fetch.md`
- **これらの「削除」はいずれも到達不能化であって消去ではない**。TTL 失効・cleanup・ブランチ削除は
  ブランチ先端から辿れなくするだけで、到達不能になった object はリモートに残り、公開中に SHA を記録した
  相手は後からでも取得できる（GitHub に GC を強制する手段は無い）。縮まるのは堆積と発見可能性だけなので、
  **集約モードに流した取得は publish 時点で恒久的に開示されたものとして扱う**（機微性の判断は cleanup の
  有無ではなくモード選択で行う）。

## セットアップ（1回だけ）

1. fine-grained PAT を発行（対象: ops-sync と全 consumer / 権限: **Contents: RW**, **Pull requests: RW**, **Workflows: RW**）。
   Workflows:RW は `shared/.github/workflows/`（例: `branch-cleanup.yml`・`net-fetch.yml`）を consumer へ配布するために必須
   （GitHub は `.github/workflows/` 配下を Workflows 権限の無い PAT で push させない。無いと sync が失敗する）。
2. 本リポジトリの Actions Secret（<https://github.com/65edh5ih/ops-sync/settings/secrets/actions>。
   メニュー: Settings → Secrets and variables → Actions → Secrets）に **`OPS_SYNC_TOKEN`** として登録。
3. ops-sync の `main` にブランチ保護を掛ける（PAT による直 push の防止）。
4. `AGENTS_COMMON.md` を main に置く（初回 push で workflow が走り、各 consumer へ配線PRが立つ）。
5. **Actions 月枠の信号用に2本目の PAT を発行**（権限: **Account permissions → Plan: Read-only** のみ。
   billing API は repo スコープでは読めないためアカウント権限が要る）。発行画面:
   <https://github.com/settings/personal-access-tokens>（メニュー: Settings → Developer settings →
   Personal access tokens → Fine-grained tokens）。本リポジトリの Actions Secret
   （<https://github.com/65edh5ih/ops-sync/settings/secrets/actions>）に
   **`ACTIONS_QUOTA_TOKEN`** として登録する。**未登録だと `quota/actions/actions.json` が `unknown` のままになり、
   全 consumer のエージェントが private repo での自発的な workflow 実行を止める**（安全側だが何も動かせない）。
   しきい値を既定の 90% から変えるときは repo variable `ACTIONS_QUOTA_THRESHOLD_PCT` を設定する
   （<https://github.com/65edh5ih/ops-sync/settings/variables/actions>。メニュー: Settings →
   Secrets and variables → Actions → Variables）。
   **プランの含有枠が GitHub Free の 2,000 分でないときは repo variable `ACTIONS_QUOTA_INCLUDED_MINUTES` に
   実際の分数を設定する**（enhanced billing platform の API は含有枠を返さないため設定値で持つ。旧 API が
   使えるアカウントは API の値を使うのでこの設定は不要）。
6. **Cloudflare 月枠の信号用に、読み取り専用の CF API トークンを発行**（<https://dash.cloudflare.com/profile/api-tokens>。
   **user-scoped で作る**——Workers Builds API は account-scoped トークンを受け付けない。権限:
   **Cloudflare Pages: Read** ＋ **Workers Builds Configuration: Read** ＋ **Workers Scripts: Read**）。
   本リポジトリの Actions Secret（<https://github.com/65edh5ih/ops-sync/settings/secrets/actions>）に
   **`CLOUDFLARE_QUOTA_TOKEN`**、アカウント ID を **`CLOUDFLARE_ACCOUNT_ID`** として登録する。**書き込み権限を持たせないこと**（ops-sync は public。
   切替に要る Edit 権限の操作は consumer 側が自分のトークンで行う）。未登録なら
   `quota/cloudflare/cloudflare.json` が `unknown` のままになる（安全側）。上限・閾値を変えるときは repo variable
   `CLOUDFLARE_PAGES_BUILDS_LIMIT`（既定 500）・`CLOUDFLARE_WORKERS_BUILD_MINUTES_LIMIT`（既定 3000）・
   `CLOUDFLARE_QUOTA_THRESHOLD_PCT`（既定 90）・`CLOUDFLARE_QUOTA_RATE_DAYS`（既定 7）を
   <https://github.com/65edh5ih/ops-sync/settings/variables/actions> で設定する。

consumer 側のセットアップは**不要**（workflow・Secret とも置かない）。

## 運用

- **共通ルールを変える（オーナー起点）**: `AGENTS_COMMON.md` を編集して main にマージするだけ。
- **手順系 doc（SOP）を書く・直す**: 書式は `shared/docs/sop-format.md`（consumer では `docs/sop-format.md`。
  リポジトリ固有の手順 doc にも適用される）。共通 SOP には `shared/.claude/skills/<name>/SKILL.md` の skill
  ラッパーを添えると、Claude Code / Codex / OpenHands（V1）/ Gemini CLI / Qwen Code / Cline / Antigravity が
  自動発火できる（各エージェント向けミラー `.codex` / `.openhands` / `.gemini` / `.agents`〔Antigravity〕/
  `.qwen`〔Qwen Code〕/ `.cline`〔Cline〕は apply-shared が配布時に自動生成する。ops-sync に置くのは正本1ファイルだけ）。
  OpenHands V0 は skill を読まないため、
  常時ロードの `shared/.openhands/microagents/repo.md`（AGENTS.md へのポインタ）経由で、AGENTS.md →
  `docs/<name>.md` を辿らせる（詳細は `shared/docs/ops-sync-design.md`「前提・限界」）。
- **共通ファイル・doc を変える**: `shared/` 配下を編集して main にマージ。**撤去・改名したときは**
  旧パスが manifest 管理下なら自動で消える。manifest 導入前から consumer にあるファイルは
  `sync-deletions.txt` に旧パスを追記する（役目を終えた行は collect の保守バッチが自動で刈る）。
- **別リポジトリに作業を依頼する**: `tasks/<owner>/<repo>/<時刻>-<説明>.md` を main に載せる
  （consumer 起点なら outbox の `種別: task`）。詳細は `shared/docs/cross-repo-tasks.md`。
- **consumer を増やす**: `consumers.txt` に追記し、PAT のアクセス対象にもそのリポジトリを追加する。
- **タスク履歴の統合・アーカイブ**: 自動。エージェントは履歴を本体に直接書かず、1エントリ＝1ファイルで
  `scripts/new-task-history.mjs <タスクスラッグ> "<短いタイトル>"` を実行し、時刻＋ランダムIDのファイルを
  `docs/history-inbox/`（→ `shared/docs/task-history.md`）に置く（並行PRのコンフリクト回避）。
  *Archive task histories* workflow（cron 1日1回）が ops-sync と全 consumer を巡回し、フラグメントを
  `docs/AI_TASK_HISTORY.md` へ統合＋保持量（直近2作業日分）超過分をアーカイブする PR を自動マージする。
  統合時、本体に既にある同一本文のエントリは取り込まず、そのフラグメントは削除して掃除する（重複記録の防止）。
  急ぐときは workflow を手動実行する。`docs/history-inbox/` は配布された `README.md` プレースホルダ
  （正本 `shared/docs/history-inbox/README.md`）で常設し、全フラグメント統合後もディレクトリが消えないようにする。
- **同期PRのマージ**: `sync.yml` の `MERGE_MODE` で選ぶ。`direct`（即マージ・完全自動）/
  `auto`（GitHub auto-merge。consumer に branch protection＋required checks が必要）/ `off`（手動）。
  現在は `direct`（内容レビューは ops-sync のマージ時に済んでいる、という設計）。ただし **Codex は
  マージ後の consumer 同期 PR を数分後にレビューすることがあり**、ops-sync 本体 PR に出ない指摘が出うる。
  **配布に影響する変更をマージしたら下流の同期 PR の Codex/CI を確認する**（対象の入力範囲・手順とも
  正本は `AGENTS.md`「配布変更のダウンストリーム確認」。scope をここに列挙しないのは AGENTS.md と二重化して
  ドリフトさせないため）。
- **ドリフトの自己修復**: sync は main の変更時に加えて cron（1日1回）でも全 consumer へ再適用する。
  consumer 側でマーカー区間や配布ファイルが手編集されても、翌日までに同期PRで正本へ戻る
  （差分が無ければ何も起きない）。
- **Codex レビューの未対応在庫を見る**: 上の「マージ後の同期 PR を確認する」はセッションが生きている
  間しか効かない（指摘はセッション終了後に届く）。取りこぼしの受け皿として *Codex review inbox*
  workflow（cron 毎時＋手動）が全リポジトリの**未 resolve な Codex レビュースレッド**を集め、
  private リポジトリの **`.ops-sync/codex-review-inbox-all.md`**（全リポジトリ分・リポジトリごとに
  グループ化＋セッションに貼るコピペ用の依頼文つき）と、**private consumer の
  `.ops-sync/codex-review-inbox.md`**（そのリポジトリの分だけ）に書き出す。public の ops-sync / ops-runner は
  PR 必須の `main` へ直接 push せず、走査結果を全体一覧だけに載せる。
  **一覧に載る＝未対応**で、直してスレッドを resolve すれば次回実行で消える（別途の管理表は無い）。
  メール通知を1件ずつ辿る代わりにこのファイルを見る。新しい secret は不要（`OPS_SYNC_TOKEN` の
  Pull requests 権限で読む）。仕組みと置き場の理由は
  `shared/docs/ops-sync-design.md`「Codex レビューの取りこぼし対策」。

### 上り（consumer 起点で共通ルール・ファイルを直す／作業を依頼する）

consumer での作業中に AI エージェントが気づいたことは、**正本のある ops-sync 側へ**出す。経路は2つで、
選び方と書式は `shared/docs/outbox-proposal.md`（consumer では `docs/outbox-proposal.md`）:

- **ops-sync をセッションに追加できるエージェント**（Claude Code on the web の `add_repo` 等。ユーザーの
  承諾が要る）は、正本へ**直接 PR** を出す。collect の非同期待ちが無いぶん速い。
- **その手段が無いエージェント・ユーザー不在の自律実行**は、作業リポジトリの `.ops-sync/outbox/` に
  提案ファイルを置く。

どちらでも正本に入るのはオーナーのマージ（エージェントは自分でマージしない）。outbox 経路では
ops-sync の collect workflow（cron 約6時間ごと）が拾い、
**取り込み PR**（ops-sync 側。同一リポジトリの提案はまとめて1本、`common-block-edit` には
常時層サイズの増減を自動記載）と **outbox 掃除 PR**（consumer 側）を自動生成する。
不正な提案は取り込まれず `.ops-sync/outbox/rejected/` へエラーノート付きで差し戻される
（後続の提案は止まらない）。オーナーが取り込み PR をマージすると全 consumer へ配布される。
急ぐときは ops-sync の *Collect outbox proposals* workflow を手動実行する。

## 前提・限界

`shared/docs/ops-sync-design.md` の「前提・限界」を参照（consumer の既定ブランチは `main` 前提、
初回のインライン重複は手作業、上りは全文置換＝ベースハッシュで鮮度検査、collect は1回に
1 consumer 分＝衝突する提案は次回、など）。
