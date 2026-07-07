# ai-ops 作業履歴

ai-ops での作業の「**なぜ**」の記録。書き方・アーカイブは共通規約 [`task-history.md`](task-history.md) に従う
（consumer に影響する変更・内部だけの変更の区別なくここ1箇所 → [`AGENTS.md`](../AGENTS.md)「履歴ファイル」節）。

---

## 2026-07-07 GitHub Copilot / Continue への共通ルール適用

- **なぜ**: オーナーから「Codex/Claude/Gemini/OpenHands に加え Copilot、さらに Continue にも同じルールを
  効かせたい」の依頼。設計の非依存原則（正本は `AGENTS.md` 一本、各エージェントはそこへ向けるだけ）に
  そのまま乗る。両者とも入口が**固定内容の実ファイル**（consumer 非依存・`shared/` 内に置ける）である点が
  `CLAUDE.md`/`GEMINI.md`（consumer ごとに異なる AGENTS.md を指す symlink＝`apply-entrypoints.mjs` 配線が必要）
  と決定的に違う。よって OpenHands の repo.md と同じポインタ方式にし、`shared/.github/copilot-instructions.md`・
  `shared/.continue/rules/ai-ops.md` として `apply-shared.mjs` の通常配布に乗せた（スクリプト改修ゼロ）。
- **設計判断**: Copilot の入口は `.github/copilot-instructions.md`（全サーフェスで確実に常時ロードされる
  リポジトリカスタム指示。coding agent は AGENTS.md も読み始めているが、VS Code 等も含め堅牢なのは前者）。
  Continue の入口は `.continue/rules/*.md` に frontmatter `alwaysApply: true`（no-frontmatter でも常時だが、
  意図を明示するため付与）。両者とも skill の自動発火機構が無いため、手順書層は OpenHands V0 と同じく
  AGENTS.md 常時層のトリガ→`docs/<name>.md` 参照でカバーする（ポインタにはルール本体を書かない＝
  AGENTS.md 一本化を維持）。consumer は既存の `.github/copilot-instructions.md` を持っていれば
  ai-ops 管理へ移る（他の shared ファイルと同じ所有権移管。新規ポインタなので実害は想定薄）。

## 2026-07-07 OpenHands V0 の AGENTS.md 読み込み対応・Gemini settings のノイズ除去

- **なぜ**: オーナーから「OpenHands が AGENTS.md を読まない」報告。構築版は V0 で、V0 は
  `.openhands/skills/`（V1 のみ）も AGENTS.md も既定で読まない。2026-07-05 の履歴には
  「OpenHands は AGENTS.md をネイティブに読むので設定ファイル不要」と記していたが、これは V1 前提の
  誤認だった（V0 で外れた）。V0 が常時ロードするのは repo microagent `.openhands/microagents/repo.md`
  なので、これを「AGENTS.md を読め／詳細は docs/ 参照」のポインタとして配布（ルール本体は書かず
  AGENTS.md 一本化を維持）。AGENTS.md の常時層に手順書の発火トリガ＋ポインタがテキストで入っているため、
  skill 自動発火が効かない V0 でも AGENTS.md→docs/ の参照で手順書層をカバーできる。
  `.openhands/skills/` は V1 用に前方互換で残置（symlink＝保守コスト無し）。
- **設計判断**: Gemini の「GEMINI.md がない」メッセージはオーナー確認のうえ settings で解決（symlink 不採用）。
  `GEMINI.md`/`CLAUDE.md`→`AGENTS.md` の symlink は `shared/` 配布に乗らない（apply-shared が symlink を
  実体化＝凍結し、AGENTS.md は consumer ごとにマーカー区間が異なる＆ shared/ 外）ため、settings 方式が正。
  `context.fileName` から "GEMINI.md" を外し `["AGENTS.md"]` のみに（探索対象から外れメッセージが消える／
  AGENTS.md は従来どおり読む）。エージェント別の AGENTS.md 入口の違いを設計 doc「前提・限界」に一覧化した。
- **訂正（同スレッド follow-up・#31 の想定が誤りだった）**: オーナー環境で `/memory show` が**空**＝
  `context.fileName` 方式は効いておらず AGENTS.md がロードされていなかった。起動 Tips「Create GEMINI.md
  files…」は静的でなく **context が空のサイン**（前段で「静的」と説明したのは誤り）。オーナーが実証した
  とおり、確実に効くのは **`GEMINI.md -> AGENTS.md` symlink**（Gemini 既定の GEMINI.md 探索が拾う）で、
  `CLAUDE.md` と全く同じ方式。効かない `shared/.gemini/settings.json` は撤去。
- **設計判断（自動配線への格上げ）**: 入口 symlink は AGENTS.md（consumer ごとに異なる／`shared/` 外）を
  指すため `shared/` 配布に乗らない（apply-shared が実体化＝凍結）。従来 `CLAUDE.md` は各リポジトリで手動
  symlink（＝ ai-ops が無くそうとしている手動リレー）だったので、これを機に **`apply-entrypoints.mjs` で
  sync が `CLAUDE.md`/`GEMINI.md` を自動配線**する形へ格上げ（冪等・実体ファイルは壊さない）。settings で
  読ませる案を捨てたのは、環境差（settings.json の探索場所・スキーマ差）に依存せず symlink が version 非依存で
  確実なため。edge ケース（新規・冪等・実体ファイル居座り・別宛先 symlink・AGENTS.md 不在）は scratch で検証。

## 2026-07-05 SOP 書式準拠化タスクを private にも起票

- **なぜ**: nikki-san に出していた「ローカル手順 doc を `docs/sop-format.md` に準拠させる」依頼
  （2026-07-05 起票分）が完了・消化済みになったのを受け、オーナーから「同じ作業を private にも」の
  依頼。private も consumer 登録済みで同じ規約下にあるため、nikki-san 版と同一内容のタスクを
  `tasks/65edh5ih/private/2026-07-05T080545-conform-local-docs-to-sop-format.md` として起票した。

## 2026-07-05 常時層（AGENTS_COMMON）のダイエット

- **なぜ**: オーナーから「内部文書を英語化してトークンを減らす案」の評価を求められ、英語化は
  (1) 削減が小さい（常時層は大半キャッシュ読み）(2) 正本の読者はレビューするオーナー自身であり
  審査精度を下げる (3) 履歴・提案は日本語照合が機能要件、として不採用。代わりに「日本語のまま圧縮」を
  提案し、常時層の点検→適用まで実施。3点: ①応答言語節から失敗事例（＝なぜ。本履歴 2026-07-02 に既出）を
  落としルール本体だけ残す ②「共通か固有か」と「常時 vs オンデマンド」を*どこへ出すか*の2軸として1節に統合
  ③横断作業の経緯を圧縮。約6.2KB→5.5KB（11%減）。
- **設計判断**: 英語化を退けた核心は「このリポジトリに『AIだけが読む文書』はほぼ無い（全正本がオーナーの
  レビュー動線上）」という点。トークン最適化より、ルールと逸話の分離による差分レビューの見通し改善を優先。
  応答言語の失敗事例を本文から削れるのは、同じ内容が履歴に恒久保管されているため（履歴の目的=判断根拠の
  恒久保管、が効いた実例）。apply-common.mjs の埋め込み（マーカー置換・固有パート保持）は scratch で再検証。

- **なぜ**: オーナーから「OpenHands も参加できるか」→「Gemini CLI も含めて足して」の依頼。
  両ツールとも SKILL.md 共通標準を読むが、スキャンパスが異なる（OpenHands: `.openhands/skills/`、
  Gemini CLI: `.gemini/skills/`）ため、Codex と同じ「正本 `.claude/` ＋ ミラー symlink」方式で追加。
  SOP 本体を `docs/` のプレーン Markdown に置いた設計のおかげで、ラッパー5本×2エージェントの
  symlink 追加だけで済んだ（本体・書式の変更なし）。
- **設計判断**: Gemini CLI は既定で GEMINI.md しか常時コンテキストに読まないため、
  `shared/.gemini/settings.json`（`context.fileName: ["AGENTS.md", "GEMINI.md"]`）も配布して
  常時ロード層（AGENTS.md 共通ブロック）を効かせた。consumer が Gemini 設定を固有化したくなったら
  この settings.json を shared/ から外す（同期がローカル編集を上書きするため）——設計 doc に明記。
  OpenHands は AGENTS.md をネイティブに読むので設定ファイル不要。OpenHands の skills は
  トリガ未指定だと常時注入になるが、ラッパーは2〜3行なのでコスト無視できると判断し、
  独自トリガ形式への分岐は導入しない（標準形式のまま全エージェント共通）。

## 2026-07-05 collect-outbox / sync workflow の Node.js 20 廃止対応

- **なぜ**: `collect-outbox.yml` 実行時に actions/checkout@v4・peter-evans/create-pull-request@v7 が
  Node20 ランタイム宣言のまま Node24 ランナーへ強制実行される旨の Deprecation Warning が出た
  （GitHub Actions ランナーの Node20 廃止 2025-09-19 changelog）。両アクションとも Node24 対応版
  （checkout@v5 / create-pull-request@v8）へ更新して解消。合わせて `sync.yml` 側の
  actions/checkout@v4・peter-evans/create-pull-request@v6 も同時に上げた（放置すると次に同じ
  Warning が出る導線だったため）。v8 で `git-token` → `branch-token` にリネームされたが、
  両 workflow とも `token` 入力しか使っておらず無関係と確認済み。

## 2026-07-05 手順 doc の SOP 書式規約と skills 配布（Agent SOP 導入）

- **なぜ**: オーナーから「Agent SOP 運用を導入したい」の依頼。評価の結果、外部プロダクト
  （AWS Strands Agent SOPs 等）の導入ではなく「既存のオンデマンド層に書式規約＋淘汰ルールを足す」
  形を採った（MCP 配布層が既存 sync と重複するため。書式の要点 = RFC 2119 制約強度・パラメータ化・
  ステップごとの完了条件だけ借りる）。オーナーの懸念2点への解: (1) リポジトリ固有 doc へも効かせる →
  規約 doc 自体を配布し、常時ロード層のトリガを「共通・固有を問わない」と明記＋ nikki-san へ既存
  ローカル doc の準拠化タスクを起票。(2) Codex 参加 → Codex は 2025-12 から同一の SKILL.md 形式を
  サポート（読み込みパスだけ `.codex/skills/` と異なる）。
- **設計判断**: skill ラッパーは `.claude/` 側を正本、`.codex/` 側を symlink にした。`apply-shared.mjs`
  は `readFileSync` でコピーするため symlink は配布時に実体化され、consumer には両パスに同一の実体
  ファイルが届く（scratch で実地検証済み）。正本を二重に持たないためのドリフト対策で、張り先は
  `shared/` 内に限る（設計 doc「前提・限界」に明記）。SKILL.md は「doc を読んで従え」の薄いポインタに
  限定し、手順本体は常に `docs/` 側（Codex/Claude どちらも読めるプレーン Markdown を正本に保つ）。
  常時層の AGENTS.md トリガは skills と重複するが残す（skills は発火の補助であって、完了手順のような
  命令はマーカー区間が正）。「世の中のベストプラクティス自動反映」（外部ソースからの SOP 自動取り込み）
  は、外部テキストを無レビューでルール正本に注入する増幅経路になるため不採用（オーナー同意済み）。
