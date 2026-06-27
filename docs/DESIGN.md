# ai-ops 設計ドキュメント

全リポジトリ（consumer）共通の **運用ルール**と**共通インフラ（ファイル）** を、ここ ai-ops を単一の正
（source of truth）として各 consumer へ自動配布するための仕組み。手動リレー（Notion へのコピペ等）を不要にし、
リポジトリ間のドリフトを構造的に防ぐのが目的。

## 解決したい問題

- 複数リポジトリ（nikki-san / private …）で AI エージェントに**同じ共通ルールを確実に効かせたい**。
- だが Claude Code on the web は **1 セッション 1 リポジトリ**で、複数ディレクトリを足しても兄弟リポジトリの
  メモリ（AGENTS.md / CLAUDE.md）は自動ロードされない。→ 「全リポジトリの AI に共通ルールを効かせる」唯一堅牢な方法は、
  **共通ルールを各リポジトリの AGENTS.md に物理的に存在させる**こと。
- 手動コピペ（Notion 等）は flow であって stock にならず、直し忘れ・コピペずれでドリフトする。

## なぜ「双方向同期」ではなく「配布＋提案」なのか

共通ファイルを複数リポジトリで相互同期すると「**書ける場所が複数化** → 多書き込みドリフト・コンフリクト」が起きる。
これは single-source-of-truth が解決したい問題そのもの。そこで方向を非対称にする:

- **下り（配布）**: ai-ops → 全 consumer。ai-ops を直すと各 consumer に同期 PR が立つ。
- **上り（提案）**: consumer → ai-ops。consumer のエージェントは「提案」を出すだけで、正本（AGENTS_COMMON.md）を
  直接書き換えない。取り込みは ai-ops 側の1回のマージに集約。

これにより **各ファイルの書き手は常に1人**に保たれる:

| ファイル | 唯一の書き手 |
|---|---|
| `AGENTS_COMMON.md` | ai-ops でのマージ（人間がレビュー） |
| consumer の `AGENTS.md` マーカー区間 | ai-ops の sync CI |
| consumer の `shared/` 由来ファイル（例: `publish-ci-logs`） | ai-ops の sync CI |
| consumer の `.ai-ops/outbox/*.md` | その consumer のエージェント |

## 二層構造: 「ルール」と「実ファイル」

共通化するものを2種類に分けている。**埋め込み方が違うので混同しない**。

1. **共通ルール（エージェントの振る舞い）** = テキスト。
   - 正本: `AGENTS_COMMON.md`
   - 配布: `scripts/apply-common.mjs` が各 consumer の `AGENTS.md` の `AI-OPS:COMMON` マーカー区間に**埋め込む**
     （マーカーが無ければ末尾に追記＝初回配線）。
2. **共通インフラ（実ファイル）** = composite action・共有スクリプト等。
   - 正本: `shared/` 配下に consumer のパスをミラーして置く（例: `shared/.github/actions/publish-ci-logs/action.yml`）。
   - 配布: `scripts/apply-shared.mjs` が同じ相対パスへ**そのまま配置**（変更時のみ）。

## コンポーネント

| ファイル | 役割 |
|---|---|
| `AGENTS_COMMON.md` | （下り・ルール）共通ルール本体。ここだけ編集する |
| `scripts/apply-common.mjs` | （下り・ルール）consumer の AGENTS.md マーカー区間へ反映 |
| `shared/**` | （下り・ファイル）consumer へ丸ごと配布する実ファイル |
| `scripts/apply-shared.mjs` | （下り・ファイル）`shared/**` を各 consumer の同じパスへコピー |
| `.github/workflows/sync.yml` | （下り）main の変更で各 consumer へ同期 PR を生成（apply-common + apply-shared） |
| `consumers.txt` | 配布先リポジトリ（`owner/repo`） |
| `scripts/collect-outbox.mjs` | （上り）consumer の `.ai-ops/outbox/*.md` 提案を `AGENTS_COMMON.md` に取り込む |
| `.github/workflows/collect-outbox.yml` | （上り）`repository_dispatch` で起動、取り込み PR＋outbox 掃除 PR を生成 |

consumer 側に必要なもの:

- `.github/workflows/notify-ai-ops.yml`: `.ai-ops/outbox/**` への push で ai-ops に `repository_dispatch` を撃つ。
- Secret `OPS_DISPATCH_TOKEN`: ai-ops に dispatch できる PAT（Contents: RW）。

## データフロー

### 下り（共通ルール／ファイルを変える・オーナー起点）

```
ai-ops: AGENTS_COMMON.md or shared/** を編集して main にマージ
   └─ sync.yml が各 consumer をチェックアウト
        ├─ apply-common.mjs: AGENTS.md のマーカー区間を更新
        └─ apply-shared.mjs: shared/** を同じパスへ配置
   └─ 各 consumer に同期 PR（ブランチ ai-ops/sync-common）
オーナーが各 consumer で同期 PR をマージ → 反映完了
```

### 上り（consumer 起点で共通ルールを直す・転記なし）

```
consumer: エージェントが .ai-ops/outbox/<時刻>-<説明>.md（共通ブロック編集後の全文）を main に push
   └─ notify-ai-ops.yml が ai-ops に repository_dispatch(outbox-proposal)
        └─ collect-outbox.yml 起動
             ├─ AGENTS_COMMON.md への取り込み PR（ai-ops 側）
             └─ outbox 掃除 PR（consumer 側）
オーナーが取り込み PR をマージ → 下りに合流して全 consumer へ配布
```

## トークン

| Secret | 置き場所 | 権限 | 用途 |
|---|---|---|---|
| `OPS_SYNC_TOKEN` | ai-ops | ai-ops＋全 consumer / Contents:RW, PR:RW | 下り同期 PR・上り取り込み/掃除 PR の作成、consumer の読み取り |
| `OPS_DISPATCH_TOKEN` | 各 consumer | ai-ops / Contents:RW | 上りの `repository_dispatch` 送信 |

> 即時性（上りをイベント駆動に）を取るため、トークンを ai-ops に集約せず consumer にも置く設計を選んだ。
> cron ポーリングに戻せば consumer 側トークンは不要だが、反映が遅延する。

## 前提・限界

- consumer の既定ブランチは `main` 前提（sync の base）。
- 初回、consumer に同等のインライン記述がある場合は、配線 PR が重複を生むため**その consumer だけ初回手作業**で
  「インライン削除＋マーカー挿入」を行う（以降はマーカーがあるので置換され重複しない）。
- **上りは現状「共通ルール（テキスト）」のみ**。共通インフラ**ファイル**を consumer 起点で提案する経路は未整備
  （必要になったら shared/ 用の outbox を足す）。
- Codex は `AGENTS.md`、Claude Code は `CLAUDE.md` を読む。consumer 側で `CLAUDE.md -> AGENTS.md` symlink にすれば
  両エージェントが同じ AGENTS.md（＝配布される共通ブロック）を読む。
