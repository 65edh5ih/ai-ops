# outbox 提案の書き方（consumer → ai-ops の上り）

共通ルール・共通ファイルの修正や、別リポジトリへの作業依頼に気づいたとき、consumer 側から
ai-ops（単一の正）へ**転記なしで**届けるための提案の書式。発火条件（いつ提案するか）は
共通ブロック（`AGENTS.md`）側にある。このドキュメントは*具体的な書式*を扱う。実際に提案を書くときに読む。

## 共通の決まり

- 置き場所: 作業中リポジトリの `.ai-ops/outbox/<時刻>-<短い説明>.md`。
- ファイル名は **`YYYY-MM-DDThhmmss-<短い説明>.md`**（先頭の時刻で処理順が決まる）。
- **必ず先頭に frontmatter を付けて種別を明示する**（種別不明の提案は collect が安全のためスキップする）。
- frontmatter に **`理由:`（1行）** を付ける。取り込み PR の本文に転記され、「なぜ」の恒久記録になる
  （このため Notion 等への別途記録は不要）。
- このファイルを consumer の `main` に載せれば（通常の PR でよい）、ai-ops の collect workflow
  （**cron: 約6時間ごと**）が拾って取り込み PR を自動生成する。急ぐ場合はユーザーに
  「ai-ops の *Collect outbox proposals* workflow を手動実行してください」と伝える。
- collect は**1回の実行で、最古の提案を持つリポジトリの提案をまとめて**処理する。別リポジトリの提案と、
  同一実行内で衝突する提案（2件目以降の `common-block-edit`・対象パスが重複する `shared-file`。いずれも
  全文置換）は、先行の cleanup PR がマージされた後の実行で処理される（複数積んでも消えない）。
- **不正な提案**（種別不明・必須項目の欠落・空本文・削除率超過など）は取り込まれず、
  `.ai-ops/outbox/rejected/` へエラーノート付きで差し戻される（後続の提案は止まらない）。
  直すときはノートに従って修正し、**新しいファイル名**で `.ai-ops/outbox/` に置き直す
  （`rejected/` 内のファイルは処理されない）。
- 各リポジトリの `AGENTS.md` のマーカー区間や配布済み `docs/` を直接書き換えない
  （上書きされて消えるだけでなく、ドリフトの原因になる）。

## 種別ごとの書式

### `common-block-edit` — 共通ルール（テキスト）の修正

共通ブロック全文を置く（差分ではなく全文）。**`ベース:` に編集元ブロックのハッシュを必ず入れる**。
取り込みは全文置換なので、提案後に正本が変わっていた場合、ベース不一致で検知しないと
その変更が黙って巻き戻る。ハッシュは作業リポジトリのルートで:

```sh
node -e 's=require("fs").readFileSync("AGENTS.md","utf8");b=s.split(/<!-- AI-OPS:COMMON START[^>]*-->/)[1].split("<!-- AI-OPS:COMMON END -->")[0];console.log(require("crypto").createHash("sha256").update(b.trim()).digest("hex").slice(0,12))'
```

```markdown
---
種別: common-block-edit
ベース: <上のコマンドの出力（12桁hex）>
理由: <この変更がなぜ必要か・1行>
---
（ここに共通ブロックの中身を全文コピーし、必要な変更を加える）
```

### `shared-file` — 共有実ファイル・共通 doc の修正

`対象パス` は `shared/` からの相対パス。composite action・共有スクリプトだけでなく、
**共通のオンデマンド doc も対象**（`対象パス: docs/<name>.md`、配布先は consumer の `docs/<name>.md`）。
全文置換なので、複数 doc にまたがる再構成は 1 doc ずつ複数の提案に分けるか、`種別: task` で
ai-ops への一括編集を依頼する（`対象リポジトリ:` に ai-ops 自身は指定できないため、その場合は
ユーザーに「ai-ops のセッションで対応してほしい」と依頼文をチャットに出す）。

```markdown
---
種別: shared-file
対象パス: .github/actions/my-action/action.yml
理由: <この変更がなぜ必要か・1行>
---
（ここにファイルの全文を書く）
```

### `task` — 別リポジトリへの作業依頼

本文は対象リポジトリの `.ai-ops/tasks/` に配布され、**このセッションの文脈を何も持たない**
エージェントが読む。書き方と依頼後の手順は [`docs/cross-repo-tasks.md`](cross-repo-tasks.md) を必ず読む。

```markdown
---
種別: task
対象リポジトリ: <owner>/<repo>（consumers.txt に載っているリポジトリのみ）
理由: <なぜこの作業が要るか・1行>
---
（自己完結した依頼本文。cross-repo-tasks.md の必須項目に従う）
```

### `task-done` — 自リポジトリ宛タスクの消化報告

`.ai-ops/tasks/` のタスクを完了したら出す。ai-ops 側の `tasks/<このリポジトリ>/<対象ファイル>` が
削除され、次回 sync で手元の `.ai-ops/tasks/` からも消える。

```markdown
---
種別: task-done
対象ファイル: <消化したタスクのファイル名（.ai-ops/tasks/ 内の名前そのまま）>
理由: <結果の要約・1行>
---
（必要なら補足。省略可）
```

## 取り込みの流れ（何が起きるか）

1. collect workflow が提案を処理し、**ai-ops への取り込み PR**（同一リポジトリの提案はまとめて1本。
   `common-block-edit` には常時層サイズの増減が自動記載される）と **提案元への outbox 掃除 PR**
   （取り込み済みの削除＋不正な提案の `rejected/` への差し戻し）を生成。
2. オーナーが取り込み PR をマージ → sync workflow が全 consumer へ配布（sync PR は設定により自動マージ）。
3. 却下する場合はオーナーが両 PR を close（提案本文は取り込み PR の差分に残る）。
