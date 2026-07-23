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
