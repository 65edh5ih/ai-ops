# ai-ops 作業履歴

ai-ops での作業の「**なぜ**」の記録。書き方・アーカイブは共通規約 [`task-history.md`](task-history.md) に従う
（consumer に影響する変更・内部だけの変更の区別なくここ1箇所 → [`AGENTS.md`](../AGENTS.md)「履歴ファイル」節）。

---

## 2026-07-13 命名ポリシーの例外解消（配布doc 2本を小文字ケバブ化）とルール4種の共通昇格

- **なぜ（改名）**: 前日に共通化した「小文字=配布 doc・大文字=ローカル doc」規約に、配布 doc 側の
  例外が2つ残っていた（`docs/OPS_SYNC_DESIGN.md`・`docs/reference/MERGED_BRANCH_GUARD.md`）。
  ユーザーから「ポリシーが無いなら揃えたい。ファイル名はゼロベースで設計し直してよい」と明示指示を
  受け、例外ゼロの形（配布=小文字ケバブ・docs/ 直下、reference/ はローカル専用）に確定。
  `shared/docs/ops-sync-design.md`・`shared/docs/merged-branch-guard.md` へ改名（manifest 差分で
  consumer 側の旧パスは自動削除・新パスが配布される）。ai-ops 内の参照（AGENTS.md・README・
  symlink・pre-push コメント・workflow コメント）も追随。
- **なぜ（昇格）**: consumer の AGENTS 固有パートに書かれていたが内容が全リポジトリ共通だったルールを
  共通ブロックへ移した（nikki-san 発: 1依頼=1PR／マージ確認は無条件・「動作確認した」報告は
  マージ済みの疑い／リネーム・統合時は元ファイルの機能一覧を先に列挙。両リポジトリ重複:
  コミットメッセージ言語）。consumer 側の重複記述は各リポジトリの同名ブランチで削除。
- **Notion 引き継ぎは昇格せず削除**: nikki-san の AGENTS にあった Notion `AI Cross-Repo Task Log` の
  引き継ぎ節を一度共通ブロックへ昇格したが、**この運用は ai-ops 運用開始で廃止済み**とユーザーから
  指摘を受け取り消した（配布 doc `cross-repo-tasks.md`「Notion 等の外部ツールへの転記は不要」・
  `outbox-proposal.md`「Notion 等への別途記録は不要」が現行の正）。nikki-san 側の節は廃止済みの
  残骸だったので削除のままが正しい。

## 2026-07-12 共通ブロックに「doc の置き場と命名」節を追加（規格統一）

- **なぜ**: ドキュメント規格・置き場統一の横断作業（nikki-san / private / ai-ops の3セッション同時）で、
  「docs/ 直下の小文字名＝ai-ops 配布 doc」という見分け規約が nikki-san のローカル規約
  （docs/README.md）にしかなく、private では初期からの独自ルール（ローカル doc が小文字名・構成の
  正本 doc なし）と衝突していた。consumer 側での是正（private のリネーム・docs/README.md 新設、
  nikki-san の reference/incidents 層の整理）と同時に、規約自体を共通ブロックへ昇格して以後の
  ドリフトを防ぐ。
- 内容: ローカル doc は大文字スネーク名／小文字は配布 doc（正確な一覧は sync-manifest）、
  標準サブディレクトリ（reference / incidents / history-archive）の意味、構成の正本は各リポジトリの
  `docs/README.md`、サブディレクトリ README に正本を置かない。
- ai-ops 自身は共通ブロックを AGENTS.md に埋め込んでいない（配布元）ため、この規約の適用先は
  consumer のみ。ai-ops の docs/ は shared/docs への symlink 構成のままでよい。

## 2026-07-12 マージ済みブランチ防止ガード（doc＋pre-pushフック）を配布物に昇格

- **なぜ**: doc 導線の横断監査（nikki-san セッション発）で、`MERGED_BRANCH_GUARD.md` が nikki-san と
  private に**独立に重複**し drift していると判明（nikki-san 77行 / private 43行、`.githooks/pre-push`
  も別物）。しかも **private 版は nikki-san が 2026-06-27 に「この環境では原理的に機能しない」と実証して
  廃止した古い方式**（`git ls-remote` でブランチ消滅を検知して push を機械的にブロック）そのままだった。
  この環境ではハーネスが未 push ブランチにも remote-tracking ref を seed し、`ls-remote`/`fetch` が
  今セッションの push を返さないため、正当な push を毎回誤ブロックする。オーナー判断で「よりちゃんとした
  nikki-san 版に寄せて ai-ops 配布に一本化」＝同じ関心事を repo ごとに手作りする drift をやめる。
- **何をしたか**: nikki-san の現行版（非ブロック・reflog の「update by push」で再 push だけをリマインド）を
  `shared/docs/reference/MERGED_BRANCH_GUARD.md`（doc 内の repo 固有節名参照だけ「ブランチ・PR の規律」に
  汎用化）と `shared/.githooks/pre-push` に昇格。`AGENTS_COMMON.md` の「ブランチ・PR の規律」節に doc への
  導線1行を追加（配布 doc の導線は共通ブロックに置く＝doc と一緒に全 repo へ届く。今回の監査で確認した原則）。
  → 次回 sync で private の壊れたフック・古い doc が正しい版へ自動置換される。
- **判断の核（コードでは分からない点）**:
  - 配布は `apply-shared.mjs` が `shared/<path>` を consumer 同パスへミラー、manifest は自動生成
    （手編集不要）。両 consumer は既に `.githooks/pre-push` を 755 で持ち、`writeFileSync` は既存 file の
    mode を変えないため、内容だけ差し替わり実行ビットは 755 維持（実測で確認）。
  - **限界**: フックを1つも持たない新規 consumer に初配布する場合は 0644（非実行）で落ちる
    （`apply-shared` は内容コピーのみ・chmod しない）。現 consumer は 755 既存のため今回は問題なし。
    将来新 consumer を足すときは初回 sync 後に `chmod +x .githooks/pre-push` が要る（要検討事項）。
  - #476（D1 トリガの common-block-edit）は既に AGENTS_COMMON.md へ取り込み済み（hash d77746ac…）と
    確認済みなので、共通ブロック直接編集で #476 のベース不一致を起こす心配は無い。

- **なぜ**: リポジトリ間ファイル送付の仕組みの相談中に、オーナーから「1セッション=1リポジトリは
  Claude Code on the web の仕様であって、できるならやり方を示せ・ドキュメントが違うなら直せ」。
  検証したところ**できる**が正: Claude Code on the web にはユーザーの明示依頼でセッションに他リポジトリを
  追加する機能（add_repo）が実在し（本セッションのツール一覧で一次確認。公式 doc too:
  「a cloud session can access any repository the connecting GitHub account can see」）、
  AGENTS_COMMON.md の「一切アクセスできない（固定制約）」の断言のほうが古くなっていた。
- **設計判断**: 例外の詳細（ユーザー起点のみ・Claude Code 限定・AGENTS.md の自動ロードは無い）は
  OPS_SYNC_DESIGN.md「前提・限界」に1箇所だけ書き、常時層・README は「原則」＋ポインタに留める
  （常時層のサイズ抑制と「同じ事実の正本は1つ」）。エージェント起点・全エージェント対象という
  本仕組み（配布・outbox・tasks）の設計前提は崩れないため、cross-repo-tasks.md 等の運用 doc は不変。
- 関連する相談の結論（未実装・記録のみ）: リポジトリ丸ごとのコピー修正版の新設は template/fork か
  seed workflow 案、少量のサンプルファイル送付は既存 tasks 経路で可能
  （下りの `apply-shared.mjs` は `tasks/<owner>/<repo>/` を再帰配布するので添付ファイルも届く。
  上りは task 本文への貼り込み）。
- 続き（同スレッド）: オーナーの依頼で「`add_repo` がある環境では『別リポジトリなので読めません』と
  答える代わりに追加を打診する」ルールを常時層に追加。ツール仕様が「ユーザーの明示依頼時のみ実行可」で
  エージェント起点の自動追加はできない（ルールで仕様は上書きできない）ため、当初は「依頼文の提案」に
  したが、オーナーの要望（はい/いいえだけで済ませたい）で**対象リポジトリ名を明示した確認への承諾＝
  明示依頼**と解釈し、はい/いいえ確認方式に変更。ユーザー不在の自律実行・ツールが無いエージェントは
  従来どおり task 経路にフォールバック。
