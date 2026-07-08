# ai-ops 作業履歴

ai-ops での作業の「**なぜ**」の記録。書き方・アーカイブは共通規約 [`task-history.md`](task-history.md) に従う
（consumer に影響する変更・内部だけの変更の区別なくここ1箇所 → [`AGENTS.md`](../AGENTS.md)「履歴ファイル」節）。

---

## 2026-07-08 バッチ処理によるトークン節約の横展開（5項目＋トゥームストーン掃除）

- **なぜ**: タスク履歴アーカイブのバッチ化に続き、オーナーから「ほかにバッチ処理でトークン節約
  できることは？」→ 提示した候補を「全部やって」。基準はアーカイブ化と同じ
  「決定的で判断要素の無い作業を LLM のセッションから剥がす」。
- **skill ミラー自動生成**: `.codex`/`.openhands`/`.gemini`/`.agents` の skills ミラー symlink（5 skill×4=20
  ファイル）を repo から撤去し、`apply-shared.mjs` が配布時に正本 `.claude/skills/` から導出する方式へ。
  consumer 側のパス・内容は完全に同一（manifest も不変）なので配布に差分は出ない。ai-ops 自身の
  root ミラー（`.codex/skills` 等）は元から正本への symlink で、shared 内ミラーに依存していないため無傷。
- **collect の詰まり解消が最重要だった**: 旧 collect は常に最古の1件を選んでから検証し、不正なら
  exit 1 で**ファイルを outbox に残す**ため、壊れた提案1つで後続全提案が人間の介入まで永久ブロック
  だった（削除率ガードに引っかかる正当な提案でも同じ）。不正・ガード超過は `.ai-ops/outbox/rejected/`
  へエラーノート付き差し戻しに変更（cleanup PR に同乗）。`rejected/` はサブディレクトリなので
  collect の走査（ファイルのみ）に拾われない。
- **バッチ処理の単位は「同一 consumer 分」**: 取り込み PR / cleanup PR が従来どおり各1本のままで済む
  範囲で直列待ちを解消（workflow の PR 作成ステップは静的なので、複数 consumer 同時処理は PR 作成の
  ループ化が必要になり見送り）。全文置換どうしが潰し合う組（2件目以降の common-block-edit・同一
  対象パスの shared-file）だけ次回へ defer。
- **常時層サイズ計測**: common-block-edit の取り込み PR 本文に文字数増減＋概算トークン（日本語主体の
  粗い換算で2文字≒1トークン）を自動記載。常時層は全 consumer・全エージェントの全タスクに乗る
  最大の恒常コストなので、マージ判断の場で肥大化を見せる。
- **sync の cron 再適用**（1日1回）: push 起点だけだと consumer 側手編集のドリフトが「次に ai-ops を
  変えるまで」残る問題の自己修復。スクリプトは冪等・無差分なら PR ゼロなのでコスト無し。
- **トゥームストーン掃除**は collect-outbox.yml に同居（その run が clone した全 consumer をそのまま
  判定に使える）。ai-ops チェックアウトは取り込み PR 用と別に取る（peter-evans は path 内の全変更を
  拾うため、混ぜると1つの PR に混入する）。clone が欠けた consumer があれば安全側で何も刈らない。

- **なぜ**: オーナーから「アーカイブはエージェント任せでなく cron 等のバッチ処理にすべきでは。
  Gemini 無料枠など貧弱なエージェントがここでトークンを浪費して力尽きている」。アーカイブは
  日付を数えてブロックを移すだけの決定的処理で判断要素が無く、指摘どおり LLM にやらせる理由が
  無かったので、`scripts/archive-task-history.mjs` ＋ `archive-task-history.yml`（cron 1日1回・
  ai-ops＋全 consumer 巡回）に移した。
- **方式の判断**: いったん「consumer 側の push 駆動 CI」を推奨・合意したが、実装前の設計確認で
  (1)「consumer 側に workflow・Secret を置かない」原則（OPS_SYNC_DESIGN.md。増幅経路の排除）に反する、
  (2) workflow ファイルの配布には PAT への Workflows 権限追加（＝全 consumer の CI 書き換え権限）が
  要る、と分かり撤回。オーナーに再確認のうえ **ai-ops 集中バッチ**（既存 PAT のまま・consumer 配線
  ゼロ維持・collect-outbox と同じ巡回パターン）に決定。保持量はソフト目標なので日次で十分。
- 常時層（AGENTS_COMMON.md）と skill description から「アーカイブせよ」を撤去し「追記だけ・
  アーカイブは自動バッチ」に変更。本エントリ追記で3作業日分になったため、新スクリプトを
  この場で1回実行して 07-05 分を移した（新方式の実地検証を兼ねる）。

## 2026-07-07 Antigravity 対応（ルールは配線ゼロ＋ skills ミラー追加）

- **なぜ**: オーナーから「Antigravity にも対応できるか」。調査の結果、Antigravity（Google の agentic IDE）は
  v1.20.3〔2026-03〕でクロスツール標準 **AGENTS.md をネイティブに読む**ようになっており、Codex と同類。
  ai-ops は既に正本 `AGENTS.md` を全 consumer へ配布済みで、さらに Gemini CLI 向けの `GEMINI.md -> AGENTS.md`
  入口 symlink も Antigravity が優先的に拾う（読み込み優先順 `~/.gemini/GEMINI.md` → `./GEMINI.md` →
  `./AGENTS.md`）。したがって**ルール本体はコード変更・新規配布物ゼロで対応済み**。設計 doc の入口一覧と
  README に記録した（実装と設計を乖離させない完了手順に沿う）。
- **skills ミラー追加**: 当初は skills 自動発火用ミラーの配布を見送っていた（公式 doc `antigravity.google/docs`
  が 403 で、`.agent/rules/`〔単数〕と `.agents/skills/`〔複数〕の表記揺れがあり、誤パスへ配ると全 consumer に
  dead file が残るため）。オーナーが公式 `antigravity.google/docs/skills` を提示し、正しいパスが
  **`.agents/skills/<name>/SKILL.md`**（frontmatter `description` でオンデマンド発火）と確定。他エージェントと
  同じ「`.claude/skills/` を正本、各エージェントは symlink ミラー」方式で `shared/.agents/skills/` を追加した
  （apply-shared が配布時に実体化。scratch consumer で実配置を検証済み）。SKILL.md 形式は共通標準（frontmatter
  ＋薄いポインタ）で Antigravity にそのまま適合。
- **ついでの訂正**: `shared/docs/sop-format.md` の skill ラッパー一覧が、撤去済みの `.gemini/settings.json`
  方式（#31 follow-up で `GEMINI.md -> AGENTS.md` symlink に一本化）を参照したままだったので、この機に
  現行方式へ修正し `.agents/skills/`（Antigravity）を追記した。

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
