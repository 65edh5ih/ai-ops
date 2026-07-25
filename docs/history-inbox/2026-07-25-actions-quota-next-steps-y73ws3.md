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
- **`quantity` は「素の実行分数」と解釈した**（引き継ぎ doc が「取り違えると数倍ずれる」と警告していた分岐）。
  根拠は実レスポンスの `pricePerUnit` が SKU 別（Linux の分単価が単独の値として出る）で、GitHub の公表単価も
  Linux:Windows:macOS = 1:2:10 の比＝**倍率は価格側で表現されている**こと。よって含有枠の消費は
  `quantity × OS倍率` で数える。取り違えていた場合（＝ `quantity` が倍率換算済みだった場合）この実装は
  使用率を**過大**に見積もる＝早めに `tight` に倒れる安全側に外れる。
- **実レスポンスは docs の例と表記が違った**: `product` は小文字 `"actions"`（docs の例は `"Actions"`）、
  `unitType` は `"Minutes"`（docs の例は `"minutes"`）、`date` は `"2026-07-01T00:00:00Z"`（docs の例は
  `"2023-08-01"`）。**docs の例をそのまま前提に実装していたら全件取りこぼして誤判定していた**ので、
  比較は全部大小無視にした（未確認の仮説で実装しない、という引き継ぎ doc の要求が実際に効いた）。
- **`Actions storage`（GigabyteHours）を分の枠と混ぜない**。含有枠が別建てなので、artifact が溢れて
  storage に課金が乗っただけで `exhausted` にすると、自発 dispatch が無関係な理由で恒久的に止まる。
  分の枯渇は分課金項目の `netAmount` と使用率で直接見る。
- **分課金項目が1件も無い月は `ok`（使用0）ではなく `unknown` にした**。「本当に使用0」と
  「`unitType` の表記が変わって全件落ちた」を区別できず、後者を `ok` と読むと*恒久的な*誤 `ok` になる。
  月初に一時的に `unknown` が出る不便より fail-open を嫌う。同じ理由で未知 SKU の分項目も `unknown`
  （倍率を推測しない）。
