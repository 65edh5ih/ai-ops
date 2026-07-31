#!/usr/bin/env node
// デプロイ経路の**推奨を決めて公開する**だけの処理（実際の切替は行わない）。
//
// **判断と実行を分離している**のが要点:
//   - 判断（ここ）… public な ops-sync で動く。Actions 分を消費しないので、守るべき枠を自分で削らない。
//     **consumer にも Cloudflare にも一切アクセスしない**ので、ops-sync に新しい資格情報を置かずに済む。
//     これは ops-sync-design.md の「ops-sync に置く CF トークンは読み取り専用にする」（MUST NOT: 書き込み
//     権限を持たせる）を守るための設計。public 側に権限を集中させない。
//   - 実行（consumer 側の workflow）… 自分のトークンで自分の経路を切り替える。切替が要るときにしか
//     動かないので、consumer の枠を使うのは実際に切り替える瞬間だけ。
//
// 出力は ci-logs の `deploy-route/decision.json`（ops-sync は public なので consumer から認証なしで読める）。
// **推奨は「枠の状態から言えること」だけ**で、consumer 側の事情（policy が auto か・CF が実際に出せるか・
// HUGO_VERSION が合っているか）は**読み手が自分で確かめる**。ここで consumer の状態を持たないことが、
// 資格情報を持たないことと表裏一体になっている。
//
// **信号が無い・壊れている・古いときは推奨を出さない**（`route: null`）。推測で経路を動かすと、実態と
// 逆向きに倒して枠を焼くか配信を止めるかのどちらかになる。

import fs from 'node:fs';

const TARGETS = [
  { name: 'nikki-san/blog', repo: '65edh5ih/nikki-san', policyVar: 'BLOG_DEPLOY_POLICY', routeVar: 'BLOG_DEPLOY_ROUTE', cfResource: 'pages_builds' },
  { name: 'nikki-san/admin', repo: '65edh5ih/nikki-san', policyVar: 'ADMIN_DEPLOY_POLICY', routeVar: 'ADMIN_DEPLOY_ROUTE', cfResource: 'workers_build_minutes' },
  { name: 'private/workers', repo: '65edh5ih/private', policyVar: 'WORKERS_DEPLOY_POLICY', routeVar: 'WORKERS_DEPLOY_ROUTE', cfResource: 'workers_build_minutes' },
];

const env = process.env;

// --- 信号 -------------------------------------------------------------------

// **信号が無い・壊れている・古いときは推奨を出さない**（逼迫扱いでも ok 扱いでもなく「判断しない」）。
function readSignal(json, label) {
  let d;
  try { d = JSON.parse(json); } catch { return { usable: false, why: `${label}: JSON として読めない` }; }
  const at = Date.parse(d?.checked_at || '');
  const maxAgeH = Number(d?.stale_after_hours) > 0 ? Number(d.stale_after_hours) : 24;
  if (!at) return { usable: false, why: `${label}: checked_at が無い` };
  const ageH = (Date.now() - at) / 3_600_000;
  if (ageH > maxAgeH) return { usable: false, why: `${label}: ${ageH.toFixed(1)}h 前で古い（上限 ${maxAgeH}h）` };
  return { usable: true, data: d, ageH };
}

// 対象ごとの希望経路。**片方向ずつ条件が違う**:
//   github → cloudflare … Actions が逼迫 かつ 逃げ先(CF の当該リソース)が ok
//   cloudflare → github … Actions が ok（CF 側の状態は問わない。戻る先が空いていれば戻ってよい）
function desiredRoute(actions, cf, target) {
  const a = actions.data?.state;
  const c = cf.data?.resources?.[target.cfResource]?.state;
  if (a === 'ok') return { route: 'github', why: 'Actions 枠に余裕あり' };
  if (a === 'tight' || a === 'exhausted') {
    if (c === 'ok') return { route: 'cloudflare', why: `Actions が ${a}・CF の ${target.cfResource} は ok` };
    return { route: null, why: `Actions は ${a} だが CF の ${target.cfResource} が ${c || 'unknown'} なので退避先にできない` };
  }
  return { route: null, why: `Actions の state が ${a || 'unknown'}` };
}

// --- main --------------------------------------------------------------------

function decide() {
  const actions = readSignal(String(env.ACTIONS_SIGNAL || ''), 'actions 信号');
  const cf = readSignal(String(env.CF_SIGNAL || ''), 'cloudflare 信号');
  const out = {
    generated_at: new Date().toISOString(),
    usable: Boolean(actions.usable && cf.usable),
    signals: {
      actions: actions.usable ? { state: actions.data.state, age_hours: Number(actions.ageH.toFixed(2)) } : { unusable: actions.why },
      cloudflare: cf.usable
        ? {
            pages_builds: cf.data?.resources?.pages_builds?.state ?? null,
            workers_build_minutes: cf.data?.resources?.workers_build_minutes?.state ?? null,
            age_hours: Number(cf.ageH.toFixed(2)),
          }
        : { unusable: cf.why },
    },
    targets: {},
  };
  for (const t of TARGETS) {
    out.targets[t.name] = out.usable
      ? { repo: t.repo, policy_var: t.policyVar, route_var: t.routeVar, ...desiredRoute(actions, cf, t) }
      : { repo: t.repo, policy_var: t.policyVar, route_var: t.routeVar, route: null, why: '信号が使えないので判断しない' };
  }
  return out;
}

function main() {
  const d = decide();
  const dir = String(env.OUT_DIR || '').trim();
  if (dir) {
    // 読み手（consumer）が機械的に読む正本。人が読む要約は標準出力（＝ジョブログとCIログ）へ。
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(`${dir}/decision.json`, `${JSON.stringify(d, null, 2)}\n`);
  }
  const lines = [`usable: ${d.usable}`, `signals: ${JSON.stringify(d.signals)}`];
  for (const [name, v] of Object.entries(d.targets)) lines.push(`${name}: ${v.route ?? '（推奨なし）'} — ${v.why}`);
  console.log(lines.join('\n'));
}

// 直接実行のときだけ動かす（判断ロジックを単体テストから import できるようにするため）。
import { fileURLToPath } from 'node:url';
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { main(); } catch (e) { console.error(e); process.exit(1); }
}

export { decide, desiredRoute, readSignal, TARGETS };
