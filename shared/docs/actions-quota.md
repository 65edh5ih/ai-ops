# Actions 月枠の逼迫判定（分散実行してよいかの信号）

GitHub Actions の月枠が逼迫しているかを billing API で実測した結果を読み、**private リポジトリで
workflow を走らせてよいか**を判断するための手順。枠は**アカウント単位**で、`65edh5ih` 配下の private
リポジトリ（consumer）はすべて同じ枠を共有する。

## いつ使うか（トリガ）

- **net-fetch を分散モード（private リポジトリ自身で実行）で起動する前**（→ `docs/net-fetch.md`）。
- そのほか、エージェント自身の判断で **private リポジトリの workflow を dispatch しようとするとき**。
- **private リポジトリの定期実行（cron）の頻度・時刻を決める／変えるとき**（→ 末尾「定期実行の頻度と
  時刻の決め方」。信号を読む手順とは別で、この節だけ読めばよい）。
- 適用外: public リポジトリ（`ops-sync` / 計算基盤の `ops-runner`）での実行は枠を消費しないので、
  この判定は要らない（net-fetch の集約モードは ops-runner 実行なので対象外）。
  ユーザーが明示的に依頼した private リポジトリの通常作業（deploy 等）も対象外——ここが縛るのは
  **エージェントが自発的に枠を消費しにいく場合**。

## 前提・パラメータ

- **信号の場所**: `65edh5ih/ops-sync` の **`ci-logs` ブランチ**の **`quota/actions/actions.json`**。
  public リポジトリなので認証なしで読める。
- **中身**（自己記述。フィールドが増えても既存の意味は変えない）:

  | フィールド | 意味 |
  |---|---|
  | `state` | `ok` / `tight` / `exhausted` / `unknown` のいずれか（下記） |
  | `threshold_pct` | `tight` と判定した使用率のしきい値（既定 90） |
  | `stale_after_hours` | この時間を過ぎた `checked_at` は古すぎるとみなす契約値（既定 24） |
  | `checked_at` | 測定時刻（UTC・ISO8601） |
  | `source` | 測定に使った API 経路（`legacy:*` / `enhanced:*` / `none`） |

- **`state` の意味**:
  - `ok` … 使用率が `threshold_pct` 未満。private リポジトリで走らせてよい。
  - `tight` … 使用率が `threshold_pct` 以上。走らせない。
  - `exhausted` … 含有枠を超過し課金が発生している。走らせない。
  - `unknown` … 測定できなかった（PAT 未設定・API 変更・障害等）。**`tight` と同じ扱いにする**。
- **生の使用分数・使用率は公開しない**（ops-sync の `ci-logs` は世界公開のため、粗い band だけを出す）。
  実数が要るときはアカウントの billing 画面を見る。
- **エージェントに要る能力**: `65edh5ih/ops-sync` の `ci-logs` ブランチのファイルを読めること
  （認証不要。手段はランタイム依存で、`git fetch` でもコンテンツ取得 API でも公開 raw URL でもよい）。

## 手順

1. **`quota/actions/actions.json` を読む**（上記の場所）。
   - 完了条件: JSON が取得でき、`state` と `checked_at` が読めている。
   - **ファイルが存在しない・取得に失敗した場合は `unknown` として扱う**（MUST）。存在しないことを
     「まだ枠に余裕がある」と解釈しない（MUST NOT）。
2. **鮮度を確認する**。`checked_at` が現在時刻より `stale_after_hours` 以上前なら、`state` の値に
   かかわらず **`unknown` として扱う**（MUST）。
   - 完了条件: 「有効な `state`」か「`unknown` 扱い」かが確定している。
3. **判定に従う**。
   - `ok` … 目的の workflow を private リポジトリで dispatch してよい。
   - `tight` / `exhausted` / `unknown` … **private リポジトリで dispatch しない**（MUST NOT）。
     停止して、ユーザーに状況と代替案（public な ops-runner での集約実行・手動取得・枠リセット後の再実行）を
     提示して判断を仰ぐ（MUST）。
   - 完了条件: dispatch したか、ユーザーに判断を仰いで停止したかのどちらかになっている。
4. **`ok` 以外だったことを完了報告に書く**（MUST）。ユーザーが枠の状態を把握し、退避スイッチや
   しきい値の調整を判断できるようにするため。

> **この判定を回避しない**（MUST NOT）: 「1回だけだから」「短いジョブだから」を理由に `tight` /
> `unknown` のまま dispatch しない。枠切れ時の実行は run の失敗に留まらず、spending limit の設定次第で
> **実費課金**につながる。

## 測定側の構成（読むだけの人は不要）

- 測定は ops-sync の `actions-quota` workflow（`.github/workflows/actions-quota.yml` ＋
  `scripts/actions-quota.mjs`）が6時間ごとに実行し、結果を `ci-logs` の `quota/` へ publish する。
  **ops-sync でだけ動かす**（public なので測定自体が枠を消費しない・consumer に PAT を配らずに済む）。
- 依存 secret: ops-sync の `ACTIONS_QUOTA_TOKEN`（billing 読み取り権限のある PAT）。
  未設定なら `state=unknown` が publish され、上記の手順により安全側（実行しない）に倒れる。
- しきい値は ops-sync の repo variable `ACTIONS_QUOTA_THRESHOLD_PCT` で変えられる（未設定なら 90）。
- 旧 billing API（含有枠に対する使用分数が取れる）を優先し、取れないときは enhanced billing platform の
  使用明細（日次・SKU 別）へフォールバックして当月の Actions **分課金項目**を合計する。どちらの経路でも
  使用率を出して `ok` / `tight` を判定する（`source` にどちらを使ったかが出る）。
- **含有枠（分）の出どころは経路で違う**。旧 API 経路は API が返す値（`included_minutes`）をそのまま使う。
  enhanced 経路は API が含有枠を返さないので、ops-sync の repo variable `ACTIONS_QUOTA_INCLUDED_MINUTES`
  （未設定なら 2,000＝GitHub Free）を使う。**プランを変えたらこの値も更新する（MUST）**——enhanced 経路では
  設定値がそのまま分母になるので、更新しないと使用率が実態とずれる（含有枠が増えたのに古い小さい値のままなら
  早めに `tight` に倒れ、減ったのに大きい値のままなら `ok` を出しすぎて課金される dispatch を通してしまう）。
  不正な値は `unknown` に倒れる。
- enhanced 経路は **`unitType` が分の項目だけ**を数える。`Actions storage`（GigabyteHours）は含有枠が
  別建てなので、storage の超過だけで `exhausted` にはならない。OS 別の課金倍率（Windows 2倍・macOS 10倍）は
  SKU 名から掛け直して含有枠の消費として数える。

## 定期実行の頻度と時刻の決め方（private リポジトリの cron）

- **頻度は「月間合計への寄与」ではなく「逼迫時の限界1分への寄与」で評価する**。月間の分数で比べると
  小さな定期 run は常に誤差に見えるが、**その比較が効く場面＝逼迫時には、比較対象だった重い run が
  居ない**（デプロイ等は経路を退避させれば job ごと skip でき 0 分になる）。逃がせない run と保険の
  定期 run だけが残り、**1 run は最低1分に切り上げ課金される**ので、「いつ走ってもいい保険」に取られた
  1分が、その1分を要する run（バックアップのエクスポート等）を落とす。
- **時刻は月枠のリセット直後（1日 00:00 UTC 以降）に寄せる**。逼迫は月末に起きるので、月内のどこに
  置くかだけで「逼迫期に自発的な run を走らせない」を満たせる。
- 時刻の要件が衝突したら（「月初」と「JST 深夜」は UTC で見ると両立しない等）、**リセット後を優先する**。
  cron は「月末日」を表せない（28〜31日で変わる）ので、月末側へ寄せる解は選ばない。
- 頻度を落とすときは、**その定期実行が担っていた役割を先に確かめる**（イベント経路の取りこぼしの
  受け皿・失敗 run のリトライ等）。空振りに見える run が回復手段を兼ねていたことがある。

## よくある失敗

- **信号が無い＝余裕がある、と解釈する**: PAT 未設定・workflow 未実行・取得失敗はすべて `unknown` で、
  意味は「逼迫しているかもしれない」。手順2・3のとおり実行しない側に倒す。
- **`checked_at` を見ない**: 月枠は月初にリセットされ、使用は日中に伸びる。古い `ok` を根拠にしない。
