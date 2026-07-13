# マージ済みブランチへの追加 push を防ぐ仕組み（pre-push reminder）

「マージ済み PR のブランチに追加 push してしまい、ユーザーが見る `main` に反映されず手戻りになる」事故を
防ぐための設計メモ。2026-06-26、同一セッション内で同じ違反が複数回再発したため対策を導入し、
2026-06-27 に「機械的ブロック」から「正本＝MCP 確認＋非ブロックのリマインド」へ方針転換した。

## 結論（現在の方針）

- **正本（唯一信頼できる防衛線）= push 前に GitHub MCP `mcp__github__pull_request_read` で `merged`/`state` を確認する**（エージェントが行う）。
- `.githooks/pre-push` は **push を止めない**。今セッションで既に push 済みのブランチへ再 push するときだけ、
  上記 MCP 確認を促す**リマインドを stderr に出す**だけ。

## なぜ「規律だけ」では不十分だったか（2026-06-26）

`AGENTS.md` に「push 前にマージ済みでないか確認せよ」と書いても再発した。原因は2つ:

1. **確認を「感覚」に紐付けてしまう。** 「feedback → fix → push」が継続作業に見える場面で確認を省く。
2. **既存の確認コマンドが squash merge を検出できない（false negative）。**
   `git log --oneline origin/main..HEAD` は squash merge を検出できない（main に新 SHA を作るため常に "ahead"）。

## なぜ「機械的ブロック」も諦めたか（2026-06-27）

当初の pre-push フックは、GitHub 設定「Automatically delete head branches」でマージ時にリモートブランチが消える性質を使い、
「以前 push 済み（remote-tracking ref がある）のに今リモートに無い（`git ls-remote` で不在）＝マージ後に自動削除された」
と判定して push を**中断**していた。しかし**この作業環境ではこの判定が原理的に成立しない**ことが分かった:

1. **ハーネスがセッション開始時に seed する。** 未 push のタスクブランチにも `refs/remotes/origin/<br>` が作られる
   （reflog 理由が空・`origin/main` を指す）。→「ref があれば push 済み」という前提が崩れ、新規ブランチの初回 push が
   毎セッション「マージ済み」と誤判定された。
2. **git ミラーが今セッションの push を `ls-remote`/`fetch` で返さない（決定打）。** 実測（2026-06-27）で、
   今セッションに push した（PR も open な）ブランチが `git ls-remote --heads origin` の一覧に出てこず、
   `git fetch origin <そのブランチ>` すら `couldn't find remote ref` になった。一方 `main` は最新に保たれる。
   → `ls-remote` による存在確認は今セッション関連ブランチに対して常に「無い」を返すため、
   初回 push も正当な追加 push も区別できず誤ブロックする。

加えて、**shell から GitHub API は叩けない**（プロキシが MCP 以外を 403 で遮断。`GITHUB_TOKEN` があっても不可）ため、
フック内から `merged` を直接取得することもできない。

→ フック内で「マージ済みか」を確実に判定する手段が無い。毎セッションの誤ブロックは危険な `SKIP_MERGED_CHECK=1`
常用癖を生み、ガード自体を形骸化させていた。よって**機械的ブロックは廃止**し、確実な判定ができる
MCP 確認（エージェント側）に一本化した。

## 現在のフックの挙動

`.githooks/pre-push` は push を中断しない（常に exit 0）。判定は**信頼できる reflog だけ**を使う
（不正確な `ls-remote` は使わない）:

- コンテナはエフェメラル（毎セッション fresh clone）なので reflog = 今セッションの履歴。
- remote-tracking ref の reflog に `update by push` がある = 今セッションで既にこのブランチへ push 済み = **再 push**。
- 再 push のときだけ「マージ済みでないか MCP で確認したか」をリマインド（push は止めない）。
- 初回 push・完全新規ブランチ（seed のみ／reflog に push なし）は**無言で通す**。

```
git push
  └─ pre-push hook（常に通す。リマインドのみ）
       ├─ 初回 push / 新規ブランチ（reflog に "update by push" なし）  → 無言で通す
       └─ 再 push（reflog に "update by push" あり）                   → リマインド表示して通す
```

リマインド抑止（確認済みで不要なとき）: `SKIP_MERGED_CHECK=1 git push ...`（挙動は元々非ブロック。出力を消すだけ）。

## 有効化

`core.hooksPath` を `.githooks` に向ける。エフェメラルなコンテナではローカル設定が毎回消えるため、
`.claude/hooks/session-start.sh` がセッション開始時に `git config core.hooksPath .githooks` を張り直す。
手動なら同コマンドを1回実行する。

（※ 旧方式の前提だった GitHub 設定「Automatically delete head branches」は、現方式では判定に使っていない。）

## 限界・注意

- フックはあくまで**リマインド**であり、マージ済みかどうかは判定しない。**実際の防御は正本の MCP 確認**
  （`AGENTS.md` の「ブランチ・PR の規律」参照）。フックのリマインドが出ても、それは「再 push」というだけで
  マージ済みとは限らない。
- reflog が無効（`core.logAllRefUpdates=false`）だとリマインドが出なくなるが、既定で有効。
  仮に出なくても正本（MCP 確認）が機能していれば防御は保たれる。
- `core.logAllRefUpdates` を OFF にする変更を入れる人は、このリマインドが無力化することに留意。
