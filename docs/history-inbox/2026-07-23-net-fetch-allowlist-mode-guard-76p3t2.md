## 2026-07-23 net-fetch: 共通 allowlist に実ドメイン追加＋「allowlist 欠落時にモードを勝手に切り替えない」ルール

private リポジトリでの net-fetch テスト（`https://v2.hysteria.network/docs/Changelog/` の取得）で2つ判明:

1. **共通 allowlist が効かない**: ユーザーは `v2.hysteria.network` を「共通許可リストに追加した」認識だったが、
   ai-ops main の正本 `shared/.github/net-allowlist.txt` には入っていなかった（配布コピーやローカルを触った
   か、未マージだった可能性）。共通リストの唯一の正本は ai-ops の `shared/.github/net-allowlist.txt` で、
   sync で各 consumer の `.github/net-allowlist.txt` に配布されて初めて効く。正本に `v2.hysteria.network` を
   追加（＋ai-ops 自身のバイト一致コピー）。public な docs ドメインなので共通ベース（public 経路）に置いてよい。

2. **allowlist 欠落を分散モードで回避しようとした**: private の agent が「集約は outbox→同期→マージで非同期
   だから、今答えるために分散モード（このリポジトリ自身で実行）に切り替える」と判断しかけた。これはモード
   切り替えを allowlist 追加プロセスの回避手段に使うもので、「何を許すかはユーザーが決める」統制を崩す。
   ユーザーが停止させた。

対処（ルール）: モードは**可視性・機微性（将来は枠残量）だけ**で選ぶものと明記し、allowlist に無いドメインを
取得しようとしたら **停止してユーザーに手動追加を依頼する**（MUST）／**勝手に分散モードへ切り替えない・自分で
allowlist に足して続行しない**（MUST NOT）を、常時層 `AGENTS_COMMON.md` と手順 `shared/docs/net-fetch.md`
（モード節＋手順3）の両方に入れた。依頼にはどのファイルに何を足すかを明示する。

学び: net-fetch のモード選択（集約/分散）は「どこで実行し結果をどの可視性に置くか」の軸であって、allowlist の
穴を埋める手段ではない。allowlist 追加はユーザー統制下の非同期手続きで、即時性より統制を優先する。
