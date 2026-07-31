## 2026-07-31 feature ブランチからの dispatch が main を書き換えた（target checkout の ref 未指定）

- PR をマージ前に検証するつもりで `archive-task-history` を**自分のブランチの ref で dispatch** したら、
  そのブランチの差分が `main` に自動マージされた（生成された PR #138 に、履歴の統合だけでなく
  ブランチの全変更が入っていた）。**レビュー前のコードが main に入る経路**で、実際に起きた。
- 原因は `Checkout target repo` の **`ref:` 未指定**。`repository:` を指定しても、それが
  *この workflow を走らせているリポジトリ自身*（ops-sync は巡回対象に自分を含む）だと、
  actions/checkout は ref 省略時に **workflow の ref** を取る。consumer 側は別リポジトリなので
  既定ブランチが取れており、**自分自身を対象にしたときだけ**成立する。
  そこから `git checkout -B ops-sync/archive-task-history` → `base: main` の PR → `MERGE_MODE=direct`
  で自動マージ、と一直線に繋がる。
- **この穴は今回の変更で作ったものではない**（checkout ステップは元から同じ）。`peter-evans` 時代から
  あって、feature ブランチから dispatch する人が居なかったので露見していなかっただけ。
  自分でそれをやって踏んだ。
- 対処は `ref: main` の明示。**script source 側の checkout は ref 省略のまま**にする——そちらは
  「そのブランチのスクリプト・action で動かす」ことが dispatch 検証の目的なので、意図的に workflow の
  ref を使う。**取ってくる木（対象）と、動かすコード（スクリプト）で ref の意味が違う**のが要点。
- **collect-outbox にも同型の危険が残っている**: `Checkout ops-sync` が script source と
  「取り込み PR の作業ツリー」を兼ねているので、ブランチから dispatch すると intake PR にブランチの
  差分が乗る。こちらは提案が存在しないと PR 自体が立たないので今回は踏んでいない。分離するには
  checkout をもう1つ足す必要があり、別 PR にする。
- 教訓: **dispatch による事前検証は「読むだけ」ではない**。書き込み側（PR 作成・自動マージ）を持つ
  workflow をブランチ ref で回すのは、それ自体が main への書き込み操作になりうる。回す前に
  「この run が書き込む先はどの ref から作られるか」を確認する。
