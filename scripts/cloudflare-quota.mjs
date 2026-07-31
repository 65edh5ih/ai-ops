// Cloudflare 側の月枠（デプロイ退避先）の逼迫状態を実測し、粗い state に落とす。
//
// なぜ必要か: GitHub Actions の月枠が尽きたときの退避先が Cloudflare だが、**CF 側にも月枠がある**。
// GitHub 側だけ見て自動退避すると、今度は CF の枠を溶かして「どこにもデプロイできない」に至る。
// 単位が枠ごとに違う（GitHub=分 / Pages=ビルド回数 / Workers Builds=分）ので、共通の band に揃える。
//
// 測る対象（Free プランの上限。ともにアカウント単位）:
//   - Cloudflare Pages のビルド回数（既定 500/月）
//   - Workers Builds のビルド分数（既定 3000/月）
//
// 入力（環境変数）:
//   CFQ_TOKEN         読み取り専用の CF API トークン。**user-scoped 必須**（Workers Builds API は
//                     account-scoped トークンを受け付けない）。必要権限: Cloudflare Pages(Read) /
//                     Workers Builds Configuration(Read) / Workers Scripts(Read)
//   CFQ_ACCOUNT_ID    Cloudflare アカウント ID
//   CFQ_THRESHOLD     逼迫とみなす使用率(%)。既定 90
//   CFQ_PAGES_LIMIT   Pages のビルド回数上限。既定 500
//   CFQ_WORKERS_LIMIT Workers Builds の分数上限。既定 3000
//   CFQ_RATE_DAYS     直近レートを測る窓（日）。既定 7
//   CFQ_STALE_HOURS   消費側が「古すぎる」と判断すべき時間。既定 24
//   CFQ_OUTPUT_DIR    出力先ディレクトリ（既定 cloudflare-quota-out）
//   CFQ_NOW           テスト用の時刻上書き（ISO8601）。本番では設定しない
//
// 出力: <CFQ_OUTPUT_DIR>/cloudflare.json（全体 state ＋ リソース別 state）
//
// **公開先が world-public なので生の使用量・上限は出力しない**（ops-sync の ci-logs は世界公開。
// actions-quota と同じ方針で band と閾値だけを出す）。
//
// **使用率だけで判定しない**のが要点: Pages は月内で 19% でも、設定次第で日次レートが 10 倍変わる。
// 実際 2026-07 は watch paths を絞る前後で 32件/日 → 2件/日 に落ちた。そこで
// 「**残枠 ÷ 直近 CFQ_RATE_DAYS 日の日次レート**が月末まで持つか」も見て、持たなければ tight にする。
// 逆に「月累計 ÷ 経過日数」で平均レートを出すのは**やらない**——設定変更の前後をまたぐと実態とずれる。

const API = 'https://api.cloudflare.com/client/v4';

const token = process.env.CFQ_TOKEN || '';
const accountId = process.env.CFQ_ACCOUNT_ID || '';
const outDir = process.env.CFQ_OUTPUT_DIR || 'cloudflare-quota-out';
const staleHours = Number(process.env.CFQ_STALE_HOURS || '24');

const { writeFileSync, mkdirSync } = await import('node:fs');
const { join } = await import('node:path');

// 数値設定は壊れていたら既定へ黙って戻さず unknown に倒す（actions-quota で踏んだ fail-open と同型。
// NaN で割ると使用率が NaN になり `pct >= threshold` が常に false ＝ 使用率にかかわらず ok になる）。
function numConfig(envName, fallback, max) {
  const raw = process.env[envName];
  if (raw === undefined || String(raw).trim() === '') return { value: fallback, valid: true, raw: '' };
  const n = Number(raw);
  const valid = Number.isFinite(n) && n > 0 && n <= max;
  return { value: valid ? n : fallback, valid, raw: String(raw).slice(0, 40) };
}

const threshold = numConfig('CFQ_THRESHOLD', 90, 100);
const pagesLimit = numConfig('CFQ_PAGES_LIMIT', 500, 1_000_000);
const workersLimit = numConfig('CFQ_WORKERS_LIMIT', 3000, 1_000_000);
const rateDays = numConfig('CFQ_RATE_DAYS', 7, 31);

function emit(state, resources, note) {
  mkdirSync(outDir, { recursive: true });
  const payload = {
    state,
    resources,
    threshold_pct: threshold.value,
    projection_window_days: rateDays.value,
    stale_after_hours: staleHours,
    checked_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    source: 'cloudflare-api',
    note,
  };
  writeFileSync(join(outDir, 'cloudflare.json'), JSON.stringify(payload, null, 2) + '\n');
  console.log(`cloudflare-quota: state=${state} note=${note}`);
  for (const [k, v] of Object.entries(resources)) console.log(`  ${k}: ${v.state} (${v.note})`);
  if (process.env.GITHUB_OUTPUT) {
    writeFileSync(process.env.GITHUB_OUTPUT, `state=${state}\n`, { flag: 'a' });
  }
  process.exit(0); // 測れなくてもジョブは緑で終える（結果は必ず publish して読ませる）
}

const UNKNOWN = (note) => emit('unknown', {
  pages_builds: { state: 'unknown', note: 'not measured' },
  workers_build_minutes: { state: 'unknown', note: 'not measured' },
}, note);

// 例外を投げない（ネットワーク断で throw すると結果が書かれず、ci-logs に前回の古い state が残る＝
// 消費側が古い ok を掴む fail-open になる）。
async function api(path) {
  try {
    const res = await fetch(`${API}${path}`, {
      headers: { authorization: `Bearer ${token}`, 'user-agent': 'ops-sync-cloudflare-quota' },
    });
    let body = null;
    try { body = await res.json(); } catch { /* JSON でないことがある */ }
    // **CF が返す errors[] を落とさない**。status だけを note に残すと、次に見る人が原因を特定できず
    // 同じ調査をやり直すことになる（実例: `status 400` だけが残り、per_page の上限超過だと分からなかった）。
    // 出力先は public な ci-logs なので、code と message だけに絞る（本文全体は入れない）。
    const errors = Array.isArray(body?.errors)
      ? body.errors.map((x) => `${x?.code ?? '?'}: ${String(x?.message ?? '').slice(0, 120)}`).join(' / ')
      : '';
    return { status: res.status, body, errors };
  } catch (e) {
    return { status: 0, body: null, error: String(e?.message || e) };
  }
}

if (!threshold.valid) UNKNOWN(`CFQ_THRESHOLD must be a number in (0, 100]; got ${JSON.stringify(threshold.raw)}`);
if (!pagesLimit.valid) UNKNOWN(`CFQ_PAGES_LIMIT is invalid; got ${JSON.stringify(pagesLimit.raw)}`);
if (!workersLimit.valid) UNKNOWN(`CFQ_WORKERS_LIMIT is invalid; got ${JSON.stringify(workersLimit.raw)}`);
if (!rateDays.valid) UNKNOWN(`CFQ_RATE_DAYS must be a number in (0, 31]; got ${JSON.stringify(rateDays.raw)}`);
if (!token) UNKNOWN('CFQ_TOKEN is not set; cannot measure quota');
if (!accountId) UNKNOWN('CFQ_ACCOUNT_ID is not set');

// `CFQ_NOW` は**テスト用の時刻上書き**（ISO8601）。月初にしか現れない挙動（観測窓が経過日数で
// 頭打ちになる件）を任意の日で検証するために置いてある。**本番では設定しない**——設定すると
// checked_at も含めて全ての判定がその時刻基準になる。
const now = process.env.CFQ_NOW ? new Date(process.env.CFQ_NOW) : new Date();
if (Number.isNaN(now.getTime())) UNKNOWN('CFQ_NOW is not a valid date');
const monthPrefix = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
// 月末までの残日数（当日を含む）。月枠は暦月でリセットされる前提。
const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
const daysLeft = Math.max(1, daysInMonth - now.getUTCDate() + 1);
const rateWindowStart = new Date(now.getTime() - rateDays.value * 86400_000);
// **窓は「実際に観測できた長さ」で割る**（MUST）。当月のレコードしか数えないので、月初は窓 7 日ぶんの
// データが存在しない。それでも 7 で割ると**レートを実際より小さく見積もり、`ok` を出しすぎる**
// （例: 1日目に 60 ビルドでも 60/7≒8.6件/日 と誤読して余裕があると判断する）。
const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
const daysElapsed = (now.getTime() - monthStart) / 86400_000; // 小数（月初1時間なら 0.04）
const observedDays = Math.max(1 / 24, Math.min(rateDays.value, daysElapsed));

const inThisMonth = (iso) => typeof iso === 'string' && iso.startsWith(monthPrefix);
const parseTs = (iso) => {
  if (typeof iso !== 'string') return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};

// 使用量（当月合計）と直近窓の量から band を決める。
function classify(used, limit, recentAmount) {
  if (!Number.isFinite(used) || used < 0) return { state: 'unknown', note: 'usage is not a finite number' };
  if (used >= limit) return { state: 'exhausted', note: 'monthly allowance is used up' };
  const pct = (used / limit) * 100;
  if (pct >= threshold.value) return { state: 'tight', note: 'usage ratio is at or above threshold' };
  // 直近レートで月末まで持つか（設定変更で不連続に変わるので、平均ではなく直近窓を使う）。
  // 割るのは observedDays（窓と経過日数の小さいほう）——月初に窓ぶんのデータが無いのに窓長で割ると
  // レートを過小評価して ok を出しすぎる。
  const perDay = recentAmount / observedDays;
  const projected = used + perDay * daysLeft;
  if (projected >= limit) return { state: 'tight', note: 'projected to exceed the allowance before the month resets' };
  return { state: 'ok', note: 'within allowance and projected to stay within it' };
}

// --- Pages: 当月の「枠を消費したビルド」を数える -------------------------------------------------
// 枠を消費しないものを除く: `ad_hoc`（wrangler pages deploy＝Direct Upload）と、
// watch paths に当たらず skip されたもの。2026-07 の実測では deployment 2,079 件中 94 件だけが対象だった。
async function measurePages() {
  const names = [];
  let projectPage = 1;
  let lastFirstProject = null;
  let projectsComplete = false;
  while (projectPage <= 200) {
    const projects = await api(`/accounts/${accountId}/pages/projects?page=${projectPage}&per_page=100`);
    if (projects.status !== 200 || !projects.body?.success) {
      return { state: 'unknown', note: `pages projects list failed (status ${projects.status}${projects.errors ? ` — ${projects.errors}` : ''})` };
    }
    const items = projects.body.result || [];
    if (!items.length) {
      projectsComplete = true;
      break;
    }
    const firstProject = items[0]?.name ?? null;
    if (firstProject !== null && firstProject === lastFirstProject) {
      return { state: 'unknown', note: 'pages projects pagination did not advance' };
    }
    lastFirstProject = firstProject;
    names.push(...items.map((p) => p?.name).filter(Boolean));
    const totalPages = Number(projects.body?.result_info?.total_pages);
    if ((Number.isFinite(totalPages) && projectPage >= totalPages) || items.length < 100) {
      projectsComplete = true;
      break;
    }
    projectPage += 1;
  }
  if (!projectsComplete) {
    return { state: 'unknown', note: 'pages projects pagination reached its safety cap' };
  }
  let used = 0;
  let recent = 0;
  for (const name of names) {
    let page = 1;
    let lastFirstId = null;
    let deploymentsComplete = false;
    while (page <= 200) {
      const res = await api(`/accounts/${accountId}/pages/projects/${encodeURIComponent(name)}/deployments?page=${page}&per_page=25`);
      if (res.status !== 200 || !res.body?.success) {
        return { state: 'unknown', note: `pages deployments failed for a project (status ${res.status})` };
      }
      const items = res.body.result || [];
      if (!items.length) {
        deploymentsComplete = true;
        break;
      }
      // ページングが効いていない（同じページが返り続ける）と黙って過少カウント＝fail-open になるので落とす
      const firstId = items[0]?.id ?? items[0]?.created_on ?? null;
      if (firstId !== null && firstId === lastFirstId) {
        return { state: 'unknown', note: 'pages deployments pagination did not advance' };
      }
      lastFirstId = firstId;
      for (const d of items) {
        if (!inThisMonth(d?.created_on)) continue;
        if (d?.deployment_trigger?.type === 'ad_hoc') continue; // Direct Upload は枠を消費しない
        if (d?.is_skipped === true) continue;                   // watch paths 不一致で skip
        used += 1;
        const t = parseTs(d.created_on);
        if (t !== null && t >= rateWindowStart.getTime()) recent += 1;
      }
      const oldest = items[items.length - 1]?.created_on;
      if (!inThisMonth(oldest)) {
        deploymentsComplete = true;
        break; // 当月より古い領域に入った
      }
      page += 1;
    }
    if (!deploymentsComplete) {
      return { state: 'unknown', note: 'pages deployments pagination reached its safety cap' };
    }
  }
  return classify(used, pagesLimit.value, recent);
}

// --- Workers Builds: 当月のビルド分数を積む -----------------------------------------------------
// 所要時間フィールドは running_on〜stopped_on（無ければ initializing_on / modified_on で代替）。
// **これは実測からの推定で、Cloudflare が課金に使う定義と一致する保証は無い**（使用量を返す
// エンドポイントは見つかっていない）。桁の把握には足りるが、しきい値には余裕を持たせる前提。
async function measureWorkersBuilds() {
  const scripts = await api(`/accounts/${accountId}/workers/scripts`);
  if (scripts.status !== 200 || !scripts.body?.success) {
    return { state: 'unknown', note: `workers scripts list failed (status ${scripts.status}${scripts.errors ? ` — ${scripts.errors}` : ''})` };
  }
  const tags = (scripts.body.result || []).map((s) => s?.tag).filter(Boolean);
  let usedMin = 0;
  let recentMin = 0;
  for (const tag of tags) {
    let page = 1;
    let lastFirstId = null;
    while (page <= 200) {
      const res = await api(`/accounts/${accountId}/builds/workers/${encodeURIComponent(tag)}/builds?page=${page}&per_page=100`);
      // Workers Builds に接続していない Worker は 404 になりうる。それは0分として扱ってよい。
      if (res.status === 404) break;
      if (res.status !== 200 || !res.body?.success) {
        return { state: 'unknown', note: `workers builds failed for a worker (status ${res.status})` };
      }
      const items = res.body.result || [];
      if (!items.length) break;
      const firstId = items[0]?.build_uuid ?? null;
      if (firstId !== null && firstId === lastFirstId) {
        return { state: 'unknown', note: 'workers builds pagination did not advance' };
      }
      lastFirstId = firstId;
      for (const b of items) {
        if (!inThisMonth(b?.created_on)) continue;
        const s = parseTs(b?.running_on ?? b?.initializing_on ?? b?.created_on);
        const e = parseTs(b?.stopped_on ?? b?.modified_on);
        if (s === null || e === null || e < s) continue;
        const minutes = (e - s) / 60000;
        usedMin += minutes;
        const t = parseTs(b.created_on);
        if (t !== null && t >= rateWindowStart.getTime()) recentMin += minutes;
      }
      const oldest = items[items.length - 1]?.created_on;
      if (!inThisMonth(oldest)) break;
      page += 1;
    }
  }
  return classify(usedMin, workersLimit.value, recentMin);
}

const pages = await measurePages();
const workers = await measureWorkersBuilds();
const resources = { pages_builds: pages, workers_build_minutes: workers };

// 全体 state は**最も悪いもの**に揃える（片方でも逼迫していれば「CF へ退避してよい」とは言えない）。
const RANK = { ok: 0, tight: 1, unknown: 2, exhausted: 3 };
const worst = [pages.state, workers.state].reduce((a, b) => (RANK[b] > RANK[a] ? b : a), 'ok');
emit(worst, resources, 'measured from pages deployments and workers builds for the current month');
