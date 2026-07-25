## 2026-07-25 Actions月枠の使用率算出（enhanced billing 経路）を完成させる

`docs/reference/ACTIONS_QUOTA_NEXT_STEPS.md` の引き継ぎ手順に沿った作業。判断根拠を残す。

- **含有枠は設定値で持つしかない**（API が返さない）。既定は GitHub Free の 2,000 分（ユーザー確認済み）で、
  repo variable `ACTIONS_QUOTA_INCLUDED_MINUTES` で上書きする。**不正値は既定へ黙ってフォールバックさせず
  `unknown` に倒す**——typo した上書き値を既定で置き換えると「設定したつもりの枠と違う枠で測った ok」を
  publish しうる。`Number('2OOO')`＝`NaN` で割ると使用率が `NaN` になり `pct >= threshold` が常に false ＝
  使用率にかかわらず ok を出す fail-open で、これは `AQ_THRESHOLD` で実際に踏んだ穴と同型。
  上限 1,000,000 分の sanity check は分と秒の取り違え等の桁違いを弾くため（含有枠は最大でも
  Enterprise の 50,000 分程度）。
- **引き継ぎ doc が挙げていた「private リポジトリで publish せずに実レスポンスを確認する」案は使えない**。
  それ自体がエージェント自発の private repo dispatch であり、`quota/actions.json` が `unknown` の間は
  `docs/actions-quota.md` が禁止している行為そのもの（枠の状態を測るために枠のガードを破る循環）。
  実レスポンスの確認はユーザーのローカル実行で行った。
- **API 仕様の裏取りは net-fetch の集約モードで行った**（`docs.github.com` がセッションの egress で 403）。
  public な ai-ops 上の実行なので枠を消費せず、取得対象も公開ドキュメントで機微でない。
