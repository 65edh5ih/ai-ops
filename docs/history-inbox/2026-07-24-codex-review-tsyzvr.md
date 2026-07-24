## 2026-07-24 net-fetch SOP: 能力不足時は分散モードへ落とさず停止する（Codex #644/#406）

consumer 同期 PR（nikki-san#644 / private#406）に付いた Codex レビュー2件が、`shared/docs/net-fetch.md`
（ツール中立化 #74 で書いた版）の同じ欠陥を指摘: `add_repo` 等の集約実行能力を持たないエージェントに
「分散モードを既定にする／分散へ切り替える」と書いていた。これは**能力（ツールの有無）でモードを選ぶ**
ことになり、同 doc の原則「モードは可視性・機微性だけで選ぶ／モード切り替えを allowlist 回避に使わない」
（前提節・モード節の MUST NOT）と矛盾していた。具体的な害: 機微でない public 相当の取得でも、ホストが
共通 allowlist に無く `.github/net-allowlist.local.txt` にだけ有る場合、分散に落ちると手順 step 3 が
「許可済み」と扱って共通 allowlist へのユーザー判断を素通りし、public 相当の取得を private の Actions 枠・
非公開 `ci-logs` に落としてしまう。

修正: 集約が正しい（＝機微でない）のに集約を実行できないエージェントは、分散へ回避せず**停止して
ユーザーに集約実行（repo 追加か ai-ops への dispatch/読み取り）を依頼する**（MUST）に統一。分散で起動する
のは step 1 で取得内容が機微＝分散が正しいと判断したときだけ、と明記して doc 内の自己矛盾を解消した。
AGENTS_COMMON 側の net-fetch 節は元から「勝手に分散へ切り替えない」で正しく、修正不要。

追加（Codex private#407、別 sync #75 由来の別指摘）: step 4 で「git ref は既定ブランチを指す」が
**REST 経路だけ MUST**で、`gh`/MCP 経路は無キーワードの説明文だった。SOP 書式では無キーワード文は
「要求ではなく説明」と読まれるため、`gh`/MCP でエージェントが現在ブランチ／feature ブランチの ref を
渡してもルール上は許容され、レビュー済みでない `net-fetch.yml`・allowlist のコピーが走りうる。
修正: 「既定ブランチ ref を指す」を**全 dispatch 手段共通の MUST**（別ブランチ ref を渡すのは MUST NOT）
に格上げし、手段ごとの満たし方（REST=body の `ref`／`gh`=`--ref`／MCP=ref パラメータ）は MUST の下の
補足に整理した。同 PR にまとめた（同一 doc の連続した SOP 是正のため）。
