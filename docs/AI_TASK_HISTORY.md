# ai-ops 作業履歴

ai-ops での作業の「**なぜ**」の記録。書き方・アーカイブは共通規約 [`task-history.md`](task-history.md) に従う
（consumer に影響する変更・内部だけの変更の区別なくここ1箇所 → [`AGENTS.md`](../AGENTS.md)「履歴ファイル」節）。

---

## 2026-07-23 archive-task-history に統合時の重複排除（dedup）を追加

- **なぜ**: PR #58（自動アーカイブ）に Codex P2「重複した履歴エントリ」。`archive-task-history.mjs` は
  inbox フラグメントを本体（`AI_TASK_HISTORY.md`）と突き合わせずに無条件連結していたため、本体に既にある
  エントリと同一内容のフラグメントを置くと、統合で本体に区別できない同一レコードが2つ並ぶ。実際 `2026-07-20
  history-inbox…プレースホルダ化` の未消化フラグメントが本体の同エントリと byte 一致（trim・1402B）で残って
  いて、次バッチで二重取り込みされる生きた状態だった。
- **修正（恒久）**: 統合フェーズで、本体にある dated エントリの**本文全体（trim）**を set 化し、同一本文の
  フラグメントは取り込まない。ただしフラグメントは消費（削除）して掃除する（本体に既にあり情報は失われない）。
  inbox 内どうしの重複も同じ set で1つに畳む。全エントリが重複のファイルも consume 対象なので、次バッチが
  自動で掃除する（自己修復）。
- **判定を「本文全体一致」にした理由（コードに無い制約）**: 見出しだけの一致で消すと、同日別タイトルの正当な
  エントリ（例: 2026-07-20 が本体に2件・別内容で並存）を誤って落とす。実害のある重複は byte 一致なので本文
  全体一致だけを重複とみなす。
- **スコープの限界**: 重複判定は**本体のみ**が対象で、アーカイブ済みエントリとの突き合わせはしない（Codex
  指摘の本体二重化が対象。年ファイル全ロードは重いので見送り）。
- **応急**: 上記 07-20 重複フラグメントは同 PR で削除済み（恒久修正でも次バッチで掃除されるが、それまでの
  read 時二重を消すため即削除）。テスト基盤が無いため一時スクリプトで本体重複／非重複／inbox 内重複／
  重複のみの4ケースを検証（コミットしない）。

## 2026-07-23 branch-cleanup workflow に publish-ci-logs を後付け（Codex P2 / #63 の抜け）

#63 で追加した branch-cleanup workflow が、共通必須ルール「新規 `.github/workflows/` には publish-ci-logs で
CI ログ出力を組み込む」（`docs/ci-logs.md`）を満たしておらず、private の sync 生成 PR #397 で Codex P2 が指摘。
初版は stdout と `$GITHUB_STEP_SUMMARY` にしか出しておらず、削除結果・失敗が ci-logs ブランチに残らなかった。

対処: 正本 `shared/.github/workflows/branch-cleanup.yml`（＋ai-ops 自身のバイト一致コピー）に、docs/ci-logs.md の
手順どおり (1) `permissions: contents: write`（既存）、(2) 本体ログを `logs/ci/scripts/branch-cleanup.log` へ tee、
(3) 末尾に「Stage CI log snapshot」＋「Publish logs to ci-logs branch」を `if: always()` で追加。inline publish
（常時）層のみ。フル生ログ collector への登録は**リポジトリ固有**なので shared には入れない（collector を持つ repo
だけ、その workflows 一覧に失敗時ゲートで足す＝各 repo 側の follow-up）。

学び: 新規 workflow を書くときは docs/ci-logs.md を先に読む（#63 で読み飛ばした）。shared 配布の workflow は
全 consumer に同じ抜けが伝播するので、共通必須ルールの充足はマージ前に確認する。

## 2026-07-23 stale ブランチ手動削除 workflow（branch-cleanup）を shared 配布で新設

private の Cloudflare Workers Builds 接続で Production branch 一覧に main が出ない件の根因が、
エージェント生成の stale ブランチ大量残留（private 264本・codex/claude 主体）だったため、手動トリガの
一括削除 workflow を追加。3リポジトリ（private / nikki-san / ai-ops）に同一で入れたいので shared 配布にした。

判断・ハマりどころ:
- GitHub の "Automatically delete head branches" は**マージされた PR の head しか消さない**。close/PR無し/
  設定前のブランチは残る（＝ON でも溜まる。ユーザーが「ON なのに同症状」と指摘。仕様どおり）。だから
  掃除 workflow が要る。
- **workflow ファイルの配布には token 権限の壁**: sync は `OPS_SYNC_TOKEN`（PAT）で consumer に push するが、
  GitHub は `.github/workflows/` 配下を `workflow` 権限の無い PAT で push させない。従来の shared 配布物は
  composite action（`.github/actions/`）止まりで workflow ファイルは初。**OPS_SYNC_TOKEN に Workflows 書き込み
  権限の付与が必要**（無いと sync PR の push が consumer で失敗する）。Codex P1 の指摘どおり README・
  ops-sync-design.md（Secret 表＋設計注記）・sync.yml コメントの token 権限記載を Workflows:RW 込みに更新。
  設計 doc は元々この権限を「blast radius を広げる」と避ける論調だったが、ユーザー判断（A: shared 配布維持）で
  付与する方針とし、対象は token が既に Contents:RW を持つ同じ repo 群に限られる点を注記に明記した。
- ai-ops は sync の consumer ではない（consumers.txt = nikki-san, private のみ）ため、shared の正本に加えて
  ai-ops 自身の `.github/workflows/` にも**バイト一致コピー**を置く（両方を同時に直す）。
- 安全設計: 手動のみ（workflow_dispatch）・**既定 dry-run**・既定ブランチ/keep 一覧/オープン PR head を常に
  除外・prefixes 一致 かつ age_days（既定7）より古いものだけ対象。年齢は git committerdate で判定
  （squash マージだと ancestry でマージ済み判定できないため、prefix＋年齢＋オープン PR 除外で安全側に倒す）。
- keep 既定に nikki-san 固有の hugo-bin/deploy-logs も入れて全 consumer で1ファイルを使い回せるようにした
  （存在しない repo では無害）。

## 2026-07-23 ci-logs.md の失敗ゲート要件を RFC 2119 キーワード（MUST）化

- **なぜ**: #59 で `shared/docs/ci-logs.md` に足した「フル生ログ collector は失敗時のみ回収／新規 collector も
  同ゲート必須」を、配布先 private#392（sync 自動 PR）で Codex が P2 指摘。SOP 書式正本
  `shared/docs/sop-format.md` は「要求の強さは RFC 2119 キーワードで明示」「**キーワード無しの文は説明であって
  要求ではない前提で読まれる**」と定めるのに、当該要件が `必ず` としか書かれておらず MUST キーワードを欠いた
  ため、SOP に従うエージェントが「説明」と解釈して失敗ゲートを付け損ね、#59 が防ごうとしたコスト回帰を
  再発させうる、という指摘。正当なので正本を修正。
- **設計判断**: 該当要件を MUST 化（`collector は失敗時のみ回収する（MUST）`／`新規 collector も同ゲートを
  付ける（MUST）`）。あわせて条件式の略記禁止を `MUST NOT: == 'failure' || 'timed_out' と略す` として
  破ったら壊れる制約であることを明示（略記は GitHub Actions 式で常時真になりゲート無効化＝#59 レビューの P2）。
  修正は正本 `shared/docs/ci-logs.md` の1点のみ。private の `docs/ci-logs.md` は配布物なので手で直さず、
  sync が再配布して波及させる（private#392 のコメントにもその旨を返信）。
- **引き継ぎ**: #59 がマージ済みのため、指定ブランチ `claude/log-collection-error-only-hn3vmo` を最新 main から
  切り直して follow-up を積んだ（新規 PR）。

## 2026-07-23 dedup 挙動を共通ルール task-history.md にも反映（#60 follow-up）

- **なぜ**: #60（consolidate の dedup 追加）マージ後、Codex P2 が正本ルール `shared/docs/task-history.md` を
  指摘。統合の説明が「全フラグメントを本体へ取り込んでから削除」のままで、dedup パス（本体に既にある同一
  本文は取り込まず削除して掃除）と食い違い、重複のみの掃除 PR では正本手順が実挙動の逆を書いている状態だった。
- **対応**: 「統合とアーカイブ」節の consolidate 説明に dedup 例外を1文追記（見出しだけの一致では消さない、も明記）。
  #60 は既にマージ済みでブランチも削除されていたため、規約どおり最新 main から branch を切り直して cherry-pick
  し、別 PR として出した（マージ済み PR には積まない）。
- ops-sync-design.md・README は #60 で反映済み。3つ目の同期先が task-history.md（配布される正本ルール）。

## 2026-07-23 ai-ops を public 化（GitHub Actions 分数の枯渇対策）

ユーザー相談「Actions の月枠が切れそう。履歴アーカイブやリポジトリ間同期をやっている ai-ops を public に
しようと思うが注意点は？」を受けて public 化した。

- **なぜ public 化か**: 月内の Actions 残枠が20分未満まで枯渇し、ai-ops 自身の運用 workflow
  （sync / archive-task-history / collect-outbox）が枠切れで止まりかけていた。consumer（nikki-san / private）は
  既に Cloudflare Workers デプロイへ移行済みで、deploy が主犯ではない。**public repo は GitHub-hosted runner の
  Actions が無料**（アカウント枠を消費しない）ため、ai-ops 自身の workflow を枠から外すのが目的。
  consumer は private のままなので、そちらの Actions 分数は救われない（切り分けて認識する）。
- **public 化前の棚卸し（実施済み・クリア）**: 全 git 履歴の diff を secret パターンで走査 → 混入なし。
  インフラ機密（IP 帯・pfSense・sing-box 等）は private repo 本体にあり ai-ops にはミラーされていない。
  過去に private 宛だった `tasks/` ファイルの中身も運用手順のみ。残る露出は「`65edh5ih/private` という
  非公開 repo の存在」と運用メタ（PR 番号・workflow 名・構成メモ）のみで、これは許容と判断した。
- **入れたガード**: ①`main` のブランチ保護（無料アカウントでは **public でのみ enforced**。private 中は
  "Not enforced" 表示が正常で、public 化の瞬間に自動で効く）。承認必須は **0** にする（archive/collect が
  `gh pr merge` で自分の PR を PAT 自動マージするため、1以上にすると自動化が止まる）。②Settings → Actions →
  General の fork PR を **Require approval for all external contributors**（UI 文言が outside collaborators から
  改称された同一設定）。
- **なぜガードが要る/効く**: 唯一の機微は `OPS_SYNC_TOKEN`（全 consumer への Contents:RW/PR:RW を持つ合鍵）。
  Actions secret なので**可視性変更では露出しない**。かつ ai-ops の workflow はどれも `pull_request` で
  起動しないため fork PR からトークンを窃取する経路が構造的に無い（fork 承認制は二重の保険）。
- **PR #63 との関係**: stale ブランチ削除 workflow の shared 配布は `OPS_SYNC_TOKEN` に Workflows:write を
  要求する（設計が意図的に避けていた格上げ）。ただし PAT は既に Contents:RW を持つ＝既にクラウンジュエルで、
  増分は categorical でなく incremental。public 化は PAT の漏洩確率を上げない（上記の理由）ため、docs 更新
  （README・ops-design のトークン表）＋スコープ付与を条件に許容可、と整理した。
- 恒久的な運用前提（ai-ops=public / consumer=private の可視性モデルと帰結）は `shared/docs/ops-sync-design.md`
  「前提・限界」に現在形で記載した。

## 2026-07-23 CI ログ「失敗時のみフル収集」を正本 ci-logs.md に昇格（今後の実装へ引き継ぎ）

- **なぜ**: nikki-san #627 が `collect-deploy-run-logs.yml`（`workflow_run` のフル生ログ collector）を
  `conclusion == 'failure' || conclusion == 'timed_out'` でゲートし「失敗時のみ回収」に変えたが、この設計原則は
  nikki-san のリポジトリ固有 doc（`docs/ci/CI_LOGS.md` 他）にしか残っておらず、**配布正本
  `shared/docs/ci-logs.md` は未更新**だった。そのため「今後の実装／他 consumer の新規 collector に
  引き継がれるか」を確認したところ引き継がれない状態（正本 step4 は collector に workflow 名を登録する
  としか書いておらず、失敗ゲートに無言）。オーナー依頼で正本へ昇格し全 consumer へ配布する形にした。
- **設計判断**: CI ログは2層で、**混同しないよう正本に明記した**。①inline publish（`publish-ci-logs`,
  各 workflow 末尾 `if: always()`）＝成功・失敗問わず毎回の要約ログ。#627 でも据え置き。②フル生ログ
  collector（`workflow_run` 別 workflow）＝失敗/タイムアウト時のみ。緑 run は①で要約済みで、フル生ログの
  真価は失敗トリアージ。監視対象1完了ごとに最低1分課金のランナーを成功 run でも起こすのは空費
  （2026-07-18 の Actions 分逼迫インシデントの主因の一つ）。①を失敗ゲートしないのは、要約ログは
  成功 run でも回帰調査の一次情報になり、かつ本体ジョブに相乗りで追加ランナー0分だから。
- **展開範囲**: 正本 doc の1点更新のみ。sync が nikki-san / private の `docs/ci-logs.md` へ配布して波及する
  （＝これが「他リポジトリへの展開」の実体）。`private` は collector を持たず inline publish のみのため
  retrofit 対象なし。nikki-san は #627 で適用済み。現時点で個別 consumer への task 起票は不要。

## 2026-07-22 対応エージェントに Kimi / Qwen / Cursor / Cline / Windsurf を追加

### なぜ

ユーザー依頼「Kimi や Qwen も対応エージェントに追加してほしい。ほかに主要な追加漏れがあれば足す」。
配布の入口機構（native / 入口 symlink / 固定内容ポインタ / skill ミラー）のどこに載るかは各エージェントが
既定でどのファイルを読むかで決まるため、公式挙動を調べて振り分けた。

- **Kimi Code CLI（Moonshot）**: リポジトリ直下 `AGENTS.md`（および `.kimi-code/AGENTS.md`）を**ネイティブに
  読む** → Codex / Antigravity と同じく**追加配線ゼロ**。skill は明示呼び出し（`Skill` ツール）でディレクトリ
  自動発火機構が無いため mirror 対象外。
- **Qwen Code（Gemini CLI フォーク）**: 当初 `QWEN.md -> AGENTS.md` の入口 symlink を張ったが、Codex レビュー
  指摘（PR #57）＋公式 memory doc 確認で **Qwen は既定の `QWEN.md` に加えリポジトリ直下の `AGENTS.md` も読む**
  （"if your repository already has an AGENTS.md file … Qwen reads that too"）と判明。symlink を張ると共通ブロックが
  QWEN.md と AGENTS.md から**二重ロード**になるため撤回し、**native-AGENTS 扱い（入口 symlink なし）**に修正。
  一方 `.qwen/skills/<name>/SKILL.md` は description マッチで自動発火するので `SKILL_MIRROR_ROOTS` の `.qwen` は
  維持。＝入口は native・skill だけミラーする組み合わせ（Gemini のような二本立てにはしない）。
- **Cursor / Cline / Windsurf**: 「主要な追加漏れ」として選定（利用規模上位）。いずれも常時ロードの
  ルールファイルを持つが AGENTS.md はネイティブに読まないため、Copilot / Continue と同じ**固定内容ポインタ**を
  `shared/` に置いて誘導する（入口が consumer 非依存の実ファイル＝`apply-shared` の通常配布で届き、symlink 配線は
  不要）。ポインタ本体は書かず AGENTS.md → `docs/` 参照で手順書層をカバー（skill 自動発火機構が無いため）。
  - Cursor: `.cursor/rules/ai-ops.mdc`（frontmatter `alwaysApply: true`）
  - Cline: `.clinerules/ai-ops.md`（`.clinerules/` ディレクトリ配下の Markdown を常時ロード）。加えて Cline は
    v3.48〜 skill（`.cline/skills/<name>/SKILL.md`）を description マッチで自動発火するため（Codex レビュー指摘
    ＋公式 skill doc で確認・PR #57）、`SKILL_MIRROR_ROOTS` にも `.cline` を追加。常時ルールは `.clinerules/`
    ポインタ、SOP は `.cline/skills/` ミラーの二本立て（Gemini/Qwen と同じ構成）。Cursor/Windsurf は SKILL.md
    標準を未採用のためポインタのみ。
  - Windsurf: `.windsurf/rules/ai-ops.md`（frontmatter `trigger: always_on`・1行目から frontmatter）

### 実装

- `scripts/apply-shared.mjs`: `SKILL_MIRROR_ROOTS` に `.qwen`（Qwen）・`.cline`（Cline）を追加。
- `scripts/apply-entrypoints.mjs`: Qwen は native-AGENTS 扱いのため `ALIASES` は変更なし（QWEN.md symlink は
  張らない）。コメントにその理由（二重ロード回避）を明記。
- 新規固定内容ポインタ: `shared/.cursor/rules/ai-ops.mdc`・`shared/.clinerules/ai-ops.md`・
  `shared/.windsurf/rules/ai-ops.md`。
- `shared/docs/ops-sync-design.md`・`README.md` のエージェント別入口一覧・skill ミラー一覧・冒頭ロスターを追随。

### 検証

一時 consumer への配布で、`.qwen/skills/**` の5 skill ミラー生成・3 ポインタ配布を実駆動確認（Qwen 入口 symlink は
仕様どおり張られないことも確認）。
