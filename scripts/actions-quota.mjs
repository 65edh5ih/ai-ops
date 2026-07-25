// GitHub Actions 月枠の逼迫状態を billing API で測り、エージェントが読める粗い状態信号に落とす。
//
// なぜ必要か: net-fetch の分散モード（private repo 実行）は Actions 月枠を消費する。枠が尽きた状態で
// dispatch すると run が失敗するだけでなく、spending limit 設定次第では実費課金につながる。従来は
// 「deploy workflow の run が skipped 続きか」という間接判定しか無く（＝ユーザーが退避スイッチを
// 入れ忘れていれば逼迫を見逃す）、危険だったので実測値に置き換える。
//
// 入力（環境変数）:
//   AQ_TOKEN        billing 読み取り権限のある PAT。未設定なら state=unknown で degrade（ジョブは失敗させない）
//   AQ_ACCOUNT      対象アカウント（例: 65edh5ih）。この配下の private repo すべてが同じ月枠を共有する
//   AQ_THRESHOLD    逼迫とみなす使用率(%)。既定 90
//   AQ_INCLUDED_MINUTES  プランの含有枠（分）。既定 2000（GitHub Free）。**enhanced 経路でのみ使う**
//                        （旧 API は included_minutes を返すのでそちらを使う）。プラン変更時は repo variable
//                        ACTIONS_QUOTA_INCLUDED_MINUTES で上書きする
//   AQ_STALE_HOURS  消費側が「古すぎる」と判断すべき時間。既定 24（出力に埋めて自己記述にする）
//   AQ_OUTPUT_DIR   出力先ディレクトリ（既定 actions-quota-out）
//
// 出力: <AQ_OUTPUT_DIR>/actions.json
//   { state, threshold_pct, stale_after_hours, checked_at, source, note }
//
// **公開先が world-public なので生の分数・使用率は出力しない**（ai-ops の ci-logs は世界公開。
// 「このアカウントは今 CI 枠に余裕があるか」の粗い band だけで rule は成立するため、
// 実数はアカウント側の billing 画面に留める）。state の意味:
//   ok        … 使用率 < threshold。分散モードを使ってよい
//   tight     … 使用率 >= threshold。分散モードを使わない
//   exhausted … 含有枠を超過し課金が発生している。分散モードを使わない
//   unknown   … 測定できなかった（token 未設定・API 変更・障害等）。**安全側に倒して tight と同じ扱い**

const API = 'https://api.github.com';

const token = process.env.AQ_TOKEN || '';
const account = process.env.AQ_ACCOUNT || '';
const staleHours = Number(process.env.AQ_STALE_HOURS || '24');
const outDir = process.env.AQ_OUTPUT_DIR || 'actions-quota-out';

// **しきい値は private repo の dispatch を認可する値なので、壊れていたら必ず unknown に倒す**。
// 素の Number() だと typo（例 `9O`）が NaN になり `pct >= NaN` が常に false ＝ 使用率にかかわらず
// ok を publish する fail-open になる。100 超の値も同じく判定が発火しなくなる。
const rawThreshold = process.env.AQ_THRESHOLD ?? '90';
const parsedThreshold = Number(rawThreshold);
const thresholdValid = Number.isFinite(parsedThreshold) && parsedThreshold > 0 && parsedThreshold <= 100;
// 公開する threshold_pct は必ず妥当な数にする（NaN は JSON.stringify で null になり消費側が読めない）
const threshold = thresholdValid ? parsedThreshold : 90;

// 含有枠（分）。**下の経路2（enhanced）でのみ使う**——経路1（旧 API）は応答の `included_minutes` を
// 返すので、そちらが使えるアカウントではこの設定値を分母にしない（API の実値が常に優先）。
// 既定は GitHub Free の 2,000 分。**しきい値と同じく壊れた値は unknown に倒す**（`Number('2OOO')` の
// NaN で割ると使用率が NaN になり、`pct >= threshold` が常に false ＝ 使用率にかかわらず ok を出す
// fail-open になる。この穴は AQ_THRESHOLD で実際に踏んでいる）。上限は sanity check——含有枠は最大でも
// Enterprise の 50,000 分程度なので、桁違いの値（分と秒の取り違え等）は設定ミスとして弾く。
const INCLUDED_MINUTES_MAX = 1_000_000;
const rawIncluded = process.env.AQ_INCLUDED_MINUTES ?? '2000';
const parsedIncluded = Number(rawIncluded);
const includedValid =
  String(rawIncluded).trim() !== '' &&
  Number.isFinite(parsedIncluded) &&
  parsedIncluded > 0 &&
  parsedIncluded <= INCLUDED_MINUTES_MAX;

const { writeFileSync, mkdirSync } = await import('node:fs');
const { join } = await import('node:path');

// note には API 応答の生値を混ぜない（公開先に使用実数を落とさないため。載せるのは経路と失敗理由だけ）
function emit(state, source, note) {
  mkdirSync(outDir, { recursive: true });
  const payload = {
    state,
    threshold_pct: threshold,
    stale_after_hours: staleHours,
    checked_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    source,
    note,
  };
  writeFileSync(join(outDir, 'actions.json'), JSON.stringify(payload, null, 2) + '\n');
  console.log(`actions-quota: state=${state} source=${source} note=${note}`);
  if (process.env.GITHUB_OUTPUT) {
    writeFileSync(process.env.GITHUB_OUTPUT, `state=${state}\nsource=${source}\n`, { flag: 'a' });
  }
  // 測定できなくてもジョブは緑で終える（結果は必ず publish して読ませる。net-fetch と同じ方針）
  process.exit(0);
}

// 例外を投げない（呼び出し側は status で分岐する）。ネットワーク断で throw すると actions.json が
// 書かれないまま落ち、ci-logs に**前回の古い state が残る**＝消費側が古い ok を掴む fail-open になるため。
async function api(path) {
  try {
    const res = await fetch(`${API}${path}`, {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28',
        'user-agent': 'ai-ops-actions-quota',
      },
    });
    let body = null;
    try { body = await res.json(); } catch { /* 本文が JSON でないことがある（HTML エラーページ等） */ }
    return { status: res.status, body };
  } catch (e) {
    return { status: 0, body: null, error: String(e?.message || e) };
  }
}

if (!thresholdValid) {
  emit('unknown', 'none',
    `AQ_THRESHOLD must be a number in (0, 100]; got ${JSON.stringify(String(rawThreshold).slice(0, 40))}`);
}
if (!token) emit('unknown', 'none', 'AQ_TOKEN is not set; cannot measure quota');
if (!account) emit('unknown', 'none', 'AQ_ACCOUNT is not set');

// 経路1（旧 billing API）: 含有枠に対する使用分数が直接取れるので「9割超え」判定にそのまま使える。
// user アカウントで 404 のときは org アカウントの可能性があるので両方試す。
for (const scope of ['users', 'orgs']) {
  const { status, body } = await api(`/${scope}/${account}/settings/billing/actions`);
  if (status !== 200 || !body) continue;
  const used = Number(body.total_minutes_used);
  const included = Number(body.included_minutes);
  const paid = Number(body.total_paid_minutes_used || 0);
  if (paid > 0) emit('exhausted', `legacy:${scope}`, 'paid minutes are being consumed');
  if (!Number.isFinite(used) || !Number.isFinite(included) || included <= 0) {
    continue; // 応答形が変わっている。経路2 へ落とす
  }
  const pct = (used / included) * 100;
  emit(pct >= threshold ? 'tight' : 'ok', `legacy:${scope}`, `usage measured against included minutes`);
}

// 経路2（enhanced billing platform）: 移行済みアカウント向け。日次・SKU 別の使用明細から
// **Actions の「分」課金項目だけ**を拾い、設定値の含有枠（AQ_INCLUDED_MINUTES）に対する割合を出す。
//
// **`quantity` は「素の実行分数」と解釈する**（OS 別の課金倍率は `pricePerUnit` 側に出ている）。
// 根拠: 実レスポンスの `pricePerUnit` が SKU ごとの単価になっており（Linux の分単価が単独の値として
// 出る）、GitHub の公表単価も Linux:Windows:macOS = 1:2:10 の比で、倍率は価格側で表現されている。
// 含有枠の消費は**倍率込み**で数える（Windows 1分は含有枠を2分消費する）ので、ここで
// `quantity × OS倍率` を掛け直す。**この解釈を取り違えると使用率が数倍ずれ、しかも数字を publish
// しないので気づけない**——`quantity` が倍率換算済みだった場合、この実装は使用率を過大に見積もる
// （＝早めに tight に倒れる安全側）。
//
// 分課金以外（`Actions storage` の GigabyteHours 等）は**含有枠が別建て**なので分子にも
// 「課金発生＝exhausted」の判定にも混ぜない（artifact が溢れただけで自発 dispatch が
// 恒久的に止まるのを避ける。分の枯渇は下の使用率と netAmount で直接見る）。

// SKU 名から含有枠の消費倍率を得る。**未知の SKU は推測しない**（呼び出し側で unknown に倒す）。
// larger runner（例 `Actions Linux 4-core`）は含有枠の対象外だが、名前が linux/windows/macos を
// 含むので倍率1以上として数えられる＝使用率を過大に見積もる方向（安全側）に倒れる。
function includedMinutesMultiplier(sku) {
  const s = String(sku || '').toLowerCase();
  if (/mac\s*os|macos/.test(s)) return 10;
  if (/windows/.test(s)) return 2;
  if (/linux/.test(s)) return 1;
  return null;
}

const now = new Date();
const year = now.getUTCFullYear();
const month = now.getUTCMonth() + 1;
// 月枠は暦月でリセットされる前提で当月分を数える（`year`/`month` クエリで API 側でも絞る）。
const monthPrefix = `${year}-${String(month).padStart(2, '0')}`;

for (const scope of ['users', 'orgs']) {
  const { status, body } = await api(`/${scope}/${account}/settings/billing/usage?year=${year}&month=${month}`);
  if (status !== 200 || !body) continue;
  const items = Array.isArray(body.usageItems) ? body.usageItems : [];
  const actions = items.filter((i) => String(i?.product || '').toLowerCase() === 'actions');
  if (!actions.length) {
    emit('unknown', `enhanced:${scope}`, 'no actions usage items in response');
  }

  // クエリが効かなかった場合の保険（`date` は "2026-07-01T00:00:00Z" 形式）。日付の形が変わって
  // 全件落ちたら下の minuteItems が空になり unknown に倒れる。
  const thisMonth = actions.filter((i) => String(i?.date || '').startsWith(monthPrefix));
  // `unitType` は実レスポンスが "Minutes"、docs の例は "minutes"。表記揺れで取りこぼさない。
  const minuteItems = thisMonth.filter((i) => String(i?.unitType || '').toLowerCase() === 'minutes');

  // 分課金項目に課金が乗っている＝含有枠を超過している。
  const billed = minuteItems.reduce((sum, i) => sum + Number(i?.netAmount || 0), 0);
  if (billed > 0) {
    emit('exhausted', `enhanced:${scope}`, 'actions minutes are being billed (included allowance exceeded)');
  }

  // ここから先は「割合を出せるか」。出せない理由は全部 unknown（＝消費側は逼迫扱い）に落とす。
  // 分課金項目が1件も無い月は「使用0」ではなく unknown にする: 使用0と「`unitType` の表記が変わって
  // 全件落ちた」を区別できず、後者を ok と読むと**古い ok ではなく恒久的な誤 ok** になるため
  // （月初に一時的に unknown が出る不便より、使用率にかかわらず ok を出す fail-open を嫌う）。
  if (!minuteItems.length) {
    emit('unknown', `enhanced:${scope}`, 'no minute-metered actions usage items for the current month');
  }
  if (!includedValid) {
    emit('unknown', `enhanced:${scope}`,
      `AQ_INCLUDED_MINUTES must be a number in (0, ${INCLUDED_MINUTES_MAX}]; got ${JSON.stringify(String(rawIncluded).slice(0, 40))}`);
  }

  let used = 0;
  for (const item of minuteItems) {
    const quantity = Number(item?.quantity);
    const multiplier = includedMinutesMultiplier(item?.sku);
    // note には SKU 名も数値も載せない（publish 先が世界公開。載せるのは失敗の種別だけ）
    if (!Number.isFinite(quantity) || quantity < 0 || multiplier === null) {
      emit('unknown', `enhanced:${scope}`, 'unrecognized sku or quantity in a minute-metered item; refusing to guess');
    }
    used += quantity * multiplier;
  }

  const pct = (used / parsedIncluded) * 100;
  if (!Number.isFinite(pct)) {
    emit('unknown', `enhanced:${scope}`, 'computed usage ratio is not a finite number');
  }
  emit(pct >= threshold ? 'tight' : 'ok', `enhanced:${scope}`,
    'usage measured from minute-metered actions items against configured included minutes');
}

emit('unknown', 'none', 'both legacy and enhanced billing endpoints failed (check token permissions)');
