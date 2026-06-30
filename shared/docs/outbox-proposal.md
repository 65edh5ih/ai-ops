# outbox 提案の書き方（consumer → ai-ops の上り）

共通ルール（テキスト）や共通実ファイルの追加・修正に気づいたとき、consumer 側から ai-ops（単一の正）へ
**転記なしで**届けるための提案の書式。共通ブロック（`AGENTS.md`）側に「マーカー区間は手編集しない／提案は
`.ai-ops/outbox/` 経由」という発火条件とガードがある。このドキュメントは*具体的な書式*を扱う。実際に提案を書くときに読む。

## 共通の決まり

- 置き場所: 作業中リポジトリの `.ai-ops/outbox/<時刻>-<短い説明>.md`。
- ファイル名は **`YYYY-MM-DDThhmmss-<短い説明>.md`**（先頭の時刻で処理順が決まる）。
- **必ず先頭に frontmatter を付けて種別を明示する**（種別不明の提案は collect が安全のためスキップする）。
- このファイルを consumer の `main` に載せれば（通常の PR でよい）、ai-ops の collect workflow が拾って
  取り込み PR を自動生成する。オーナーがマージすると全 consumer へ配布される。
- 各リポジトリの `AGENTS.md` のマーカー区間を直接書き換えない（上書きされて消えるだけでなく、ドリフトの原因になる）。

## 種別ごとの書式

**共通ルール（テキスト）の提案** — frontmatter + 共通ブロック全文:

```markdown
---
種別: common-block-edit
---
（ここにマーカー区間の中身を全文コピーし、必要な変更を加える。差分ではなく全文を置く）
```

**共有実ファイル（`shared/`）の提案** — frontmatter + ファイル本文。`対象パス` は `shared/` からの相対パス。
composite action・共有スクリプトだけでなく、**共通のオンデマンド doc（`docs/` 配下）も対象**
（`対象パス: docs/<name>.md`、配布先は consumer の `docs/<name>.md`）:

```markdown
---
種別: shared-file
対象パス: .github/actions/my-action/action.yml
---
（ここにファイルの全文を書く）
```

## いつ outbox を使い、いつ Notion 依頼にするか（outbox 主・Notion 従）

- **自己完結した1点訂正**（「この1行が間違い、正しいテキストはこれ」）→ **outbox**。見つけた当のセッションが
  最良の著者で、CI が決定的に反映し、転記ゼロ。これが既定。
- **複数 doc にまたがる / 再構成が要る / どの doc を直すべきか自信がない**変更 → **Notion「AI Cross-Repo Task Log」**に
  依頼を出し、ai-ops 側のセッションが全体を見て一括編集する。outbox の全文置換は散文の編集的マージ（dedupe・再配置・
  節の統合）が苦手なので、ここだけ Notion をエスカレーション経路として使う。Notion が運ぶのは**タスク（依頼）**であって
  正本コンテンツではない（正本は常に ai-ops）。

> Notion バックログは人手で drain される（outbox のように CI で自動排出されない）。エスカレーションは
> 頻度の低い構造変更に絞り、日常の訂正は outbox に流す。
