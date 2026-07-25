# Actions 月枠の逼迫判定: enhanced billing 経路の未完部分

`actions-quota` は現在このアカウントで **`ok` / `tight` を出せず `unknown` のまま**で、当初要件
（「月枠の9割を超えたら private repo での自発 dispatch を止める」）を満たしていない。その残作業。

## 現状（2026-07-25 時点・実測済み）

`ACTIONS_QUOTA_TOKEN`（fine-grained PAT / Account permissions → Plan: Read-only）は登録済みで、
**PAT 自体は正しく機能している**。`ci-logs` の `quota/actions.json` の実測結果:

```json
{ "state": "unknown", "source": "enhanced:users",
  "note": "enhanced billing API exposes cost, not % of included minutes; not billed yet but ratio unknown" }
```

`source: enhanced:users` が判明した事実。**このアカウントは enhanced billing platform 側**で、
旧 API（`/users/{user}/settings/billing/actions`＝含有枠に対する使用分数を直接返す）は使えず、
enhanced API（`/users/{user}/settings/billing/usage`）にフォールバックしている。

`scripts/actions-quota.mjs` の enhanced 経路は金額ベースの判定しか実装しておらず、
「課金発生＝`exhausted`」か「未課金だが割合不明＝`unknown`」の二択しか出せない。

## 何が問題か

`unknown` は設計どおり安全側（逼迫扱い）に倒れるので**危険はない**。ただし裏返すと
**エージェントは private リポジトリでの自発的な workflow dispatch を永久に止め続ける**
（`docs/actions-quota.md` 手順3で `ok` 以外は MUST NOT）。安全だが何も動かせない。

## やること

`scripts/actions-quota.mjs` の enhanced 経路で使用率を算出できるようにする。

enhanced API の `usageItems[]` には `quantity`（`unitType: "Minutes"`）が含まれるはずなので、
当月の Actions 分を合算すれば使用分数が出る。ただし次の2点を**実レスポンスで確認してから**組むこと:

1. **含有枠の分数は API が返さない**（Free 2,000／Pro 3,000）。設定値として持つ必要がある。
   閾値と同じく repo variable で上書き可能にするのが素直（例 `ACTIONS_QUOTA_INCLUDED_MINUTES`）。
2. **OS 別の課金倍率**（Windows 2倍・macOS 10倍）が `quantity` に反映済みか、`pricePerUnit` 側で
   表現されているかを確認する。取り違えると使用率が数倍ずれる。

**実レスポンスの形は現在どこにも記録されていない**（公開 ci-logs に使用実数を落とさない設計のため
ログにも出していない）。形状確認の手段を決めるのが最初の一歩になる。

## 壊してはいけない不変条件

既存の設計判断（`docs/ops-sync-design.md` の「Actions 月枠の信号」節・
`docs/history-inbox/2026-07-25-actions-quota-billing-signal.md` に経緯）を崩さないこと:

- **測れなかったら必ず `unknown`**（＝消費側は逼迫扱い）。「たぶん余裕がある」で `ok` を出さない。
  `fetch` の try/catch と、workflow 側の保険ステップ（結果が残らなかったときに `unknown` を書く）は
  どちらも fail-open を塞ぐためのもので、外すと `ci-logs` に前回の古い `ok` が残り続ける。
- **生の使用分数・使用率を publish しない**。ai-ops の `ci-logs` は世界公開。出すのは band と閾値だけ。
  デバッグで実数を見たくなっても、公開経路には落とさない。
- **しきい値は `(0,100]` の有限数以外を受け付けない**（`NaN` や 100 超で判定が無効化される fail-open を
  塞いだ経緯がある）。同じ検証を新しい設定値（含有枠の分数）にも入れること。
- **ai-ops でだけ動かす**。`shared/` に移して consumer へ配布しない（枠はアカウント単位なので測定は
  1箇所でよく、public な ai-ops なら測定自体が枠を消費しない。consumer に billing PAT を配らない）。
- workflow の `run:` に `${{ vars.* }}` 等を直接埋めない（env 経由。注入経路になる）。

## 関連ファイル

| パス | 内容 |
|---|---|
| `scripts/actions-quota.mjs` | 測定ロジック（**今回の主対象**） |
| `.github/workflows/actions-quota.yml` | 6時間ごとの実行と publish |
| `shared/docs/actions-quota.md` | 消費側の手順（SOP）。判定の意味を変えるならここも直す |
| `shared/docs/ops-sync-design.md`「Actions 月枠の信号」節 | 設計判断 |
| `docs/history-inbox/2026-07-25-actions-quota-billing-signal.md` | 経緯（統合後は `docs/AI_TASK_HISTORY.md`） |
| `README.md` セットアップ手順5 | secret の権限・登録先 |
| 出力先 | `ci-logs` ブランチの `quota/actions.json` と `quota/actions-quota.log` |

consumer 側（nikki-san 等）の `docs/actions-quota.md`・`.claude/skills/actions-quota/`・`AGENTS.md` の
該当節は**配布コピー**なので手編集しない（直すのは常に ai-ops 側）。
