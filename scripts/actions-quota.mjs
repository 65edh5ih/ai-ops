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

// 経路2（enhanced billing platform）: 移行済みアカウント向け。使用明細（金額ベース）しか無く
// 「含有枠の何割か」は算出できないため、**課金が発生しているか（=含有枠超過）だけ**を見る。
// 超過していない場合は割合が不明なので ok と断定せず unknown（＝安全側）に倒す。
for (const scope of ['users', 'orgs']) {
  const { status, body } = await api(`/${scope}/${account}/settings/billing/usage`);
  if (status !== 200 || !body) continue;
  const items = Array.isArray(body.usageItems) ? body.usageItems : [];
  const actions = items.filter((i) => String(i?.product || '').toLowerCase() === 'actions');
  if (!actions.length) {
    emit('unknown', `enhanced:${scope}`, 'no actions usage items in response');
  }
  const netTotal = actions.reduce((sum, i) => sum + Number(i?.netAmount || 0), 0);
  if (netTotal > 0) emit('exhausted', `enhanced:${scope}`, 'actions usage is being billed (included allowance exceeded)');
  emit('unknown', `enhanced:${scope}`,
    'enhanced billing API exposes cost, not % of included minutes; not billed yet but ratio unknown');
}

emit('unknown', 'none', 'both legacy and enhanced billing endpoints failed (check token permissions)');
