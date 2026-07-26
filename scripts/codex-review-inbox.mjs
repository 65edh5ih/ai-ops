// Codex レビュー指摘の「未対応在庫」を全リポジトリから集め、全体一覧＋リポジトリごとのスライスに落とす。
//
// なぜ必要か: Codex のレビューは同期 PR がマージされた数分後に届くことがあり、そのとき配布変更を出した
// セッションは終わっている。ops-sync 本体の PR には出ず consumer 同期 PR にだけ出る指摘もあるため、
// 気づくには全リポジトリを見る必要がある。配布物（shared/）への指摘を取りこぼすと欠陥が全 consumer に残る。
//
// 設計の要点:
//   - **状態を持たない**。「未 resolve の Codex レビュースレッド」そのものがキュー。
//     未対応 → 一覧に載る／対応して resolve → 次の run で消える。別途の管理表を持たないのでずれない。
//   - **消える条件は「resolve された」だけ**。直近スキャンの窓から外れただけで消えないよう、前回の全体
//     一覧に載っていた PR は名指しで再確認する（持ち越し）。前回の出力が持ち越しの入力を兼ねる。
//   - **読めなかったものは落とさない**。取得に失敗したリポジトリ・PR は「取得失敗」行として残す
//     （黙って短い一覧を出すと、指摘が消えたのか読めなかったのか区別できず fail-open になる）。
//
// 入力（環境変数）:
//   CRI_TOKEN          GitHub トークン（対象リポジトリの Pull requests: read が要る）
//   CRI_REPOS          走査対象。`owner/repo` を改行か空白区切りで。`#` 以降はコメント
//   CRI_CLONES         各リポジトリのクローンを置いたディレクトリ。スライスは
//                      <CRI_CLONES>/<owner>/<repo>/.ops-sync/codex-review-inbox.md へ書く
//   CRI_OUT_ALL        全体一覧の出力先パス（**private リポジトリのクローン内**）
//   CRI_LOOKBACK_DAYS  この日数より古い更新の PR は直近スキャンで見ない。既定 3
//                      直近スキャンの役目は**新しい指摘の発見**だけでよい（Codex は PR イベントの数分後に
//                      投稿し、この workflow は15分ごとに回る）。一度載ったものは持ち越しが resolve まで
//                      守るので、窓を広く取る必要はない。窓を広げるほど GraphQL のレート消費が増える
//                      （nikki-san は30日で500 PR 超＝10ページ超）。過去分を洗い直したいときだけ
//                      workflow_dispatch で大きい値を渡して1回流す。
//   CRI_BOT            Codex のレビュー投稿者ログイン。既定 chatgpt-codex-connector
//
// 出力:
//   - <CRI_OUT_ALL> … 全リポジトリ分。**リポジトリごとにグループ化**し、各グループにセッションへ貼る
//     コピペ用の依頼文を添える。全リポジトリの内容が混ざるので private リポジトリにだけ置く。
//   - 各リポジトリの `.ops-sync/codex-review-inbox.md` … **そのリポジトリの分だけ**。どのエージェントでも
//     自分の作業リポジトリで自分の積み残しを読める（issue と違い API アクセスが要らない）。
//     public リポジトリ（ops-runner）にはそのリポジトリ自身の公開 PR の指摘しか入らない。
//   - stdout のサマリ。**ops-sync の ci-logs（世界公開）に載るので、件数と repo 名しか出さない**
//     （MUST NOT: 指摘本文・パスをログに出す。private リポジトリの内容が公開に落ちる）。
//
// 終了コード: 常に 0。
//
// 内容が実質変わらないファイルは書き換えない（生成時刻だけの差分でコミットが立たないように）。

const GRAPHQL = 'https://api.github.com/graphql';
const MAX_PAGES = 20; // 直近スキャンのページ上限（1ページ50件）。cutoff に届く前の暴走を防ぐ安全弁

const token = process.env.CRI_TOKEN || '';
const clonesDir = process.env.CRI_CLONES || '';
const outAll = process.env.CRI_OUT_ALL || '';
const bot = process.env.CRI_BOT || 'chatgpt-codex-connector';

// 壊れた値で走査範囲が 0 日になると「指摘ゼロ」を出してしまう（fail-open）ので、妥当でなければ既定に倒す。
const rawLookback = process.env.CRI_LOOKBACK_DAYS || '3';
const parsedLookback = Number(rawLookback);
const lookbackDays =
  Number.isFinite(parsedLookback) && parsedLookback >= 1 && parsedLookback <= 365 ? parsedLookback : 3;

// consumers.txt をそのまま渡せるようにする: `#` 以降はコメント、1行に1つの `owner/repo`。
// **行単位で先にコメントを落とす**（空白で分割してから `#` を弾くと、`# 計算基盤` のような
// コメント行の2語目が repo 名として残る）。形が `owner/repo` でないものは無視する。
const REPO_SHAPE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const repos = (process.env.CRI_REPOS || '')
  .split(/\r?\n/)
  .map((line) => line.replace(/#.*$/, '').trim())
  .flatMap((line) => line.split(/[\s,]+/))
  .map((s) => s.trim())
  .filter((s) => REPO_SHAPE.test(s));

const { writeFileSync, readFileSync, existsSync, mkdirSync, appendFileSync } = await import('node:fs');
const { dirname, join } = await import('node:path');

function setOutput(key, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  appendFileSync(file, `${key}=${value}\n`);
}

if (!token || !outAll || !clonesDir || repos.length === 0) {
  console.log('codex-review-inbox: missing CRI_TOKEN / CRI_OUT_ALL / CRI_CLONES / CRI_REPOS; nothing to do');
  setOutput('open_findings', '0');
  setOutput('files_changed', '0');
  process.exit(0);
}

const cutoff = new Date(Date.now() - lookbackDays * 24 * 3600 * 1000);

const PR_FIELDS = `
  number url title state merged updatedAt
  reviewThreads(first:50){
    pageInfo{ hasNextPage }
    nodes{
      isResolved isOutdated
      comments(first:1){
        nodes{ author{ login } createdAt url path body }
      }
    }
  }`;

// 直近スキャンはページングする（1ページだけだと「最近更新の50件」で切れ、lookback 期間内でも
// それより古い PR の指摘が最初から一覧に入らない）。
const QUERY = `
query($owner:String!,$name:String!,$after:String){
  rateLimit{ cost remaining resetAt }
  repository(owner:$owner,name:$name){
    pullRequests(first:50, after:$after, orderBy:{field:UPDATED_AT,direction:DESC}){
      pageInfo{ hasNextPage endCursor }
      nodes{${PR_FIELDS}}
    }
  }
}`;

// 直近スキャンの窓から外れた PR を名指しで再確認するためのクエリ（持ち越し）。
const PR_QUERY = `
query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){
    pullRequest(number:$number){${PR_FIELDS}}
  }
}`;

// 直近の rateLimit 観測値（GraphQL は 5,000 ポイント/時。15分ごとに回すので消費を見えるようにしておく）
let rate = null;

async function graphql(query, variables) {
  const res = await fetch(GRAPHQL, {
    method: 'POST',
    headers: {
      authorization: `bearer ${token}`,
      'content-type': 'application/json',
      'user-agent': 'ops-sync-codex-review-inbox',
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`http ${res.status}`);
  const json = await res.json();
  // GraphQL は HTTP 200 でも errors を返す。ここで落とさないと「指摘ゼロ」として扱ってしまう。
  if (json.errors?.length) throw new Error(json.errors.map((e) => e.type || e.message).join(','));
  if (!json.data?.repository) throw new Error('no repository in response');
  if (json.data.rateLimit) rate = json.data.rateLimit;
  return json.data.repository;
}

// Codex の指摘本文は `**<sub><sub>![P2 Badge](...)</sub></sub>  <見出し>**` で始まる。
// 見出しと優先度だけ取り出す（本文全体は載せない——リンク先で読める）。
function parseFinding(body) {
  const priority = body.match(/!\[(P[0-9])\s+Badge\]/)?.[1] || '--';
  const firstBold = body.match(/\*\*(?:<sub>|<\/sub>|!\[[^\]]*\]\([^)]*\))*\s*([^*]+?)\s*\*\*/);
  const title = (firstBold?.[1] || body.split('\n')[0] || '').replace(/\s+/g, ' ').trim();
  return { priority, title: title.slice(0, 160) };
}

function daysAgo(iso) {
  return Math.floor((Date.now() - new Date(iso).getTime()) / (24 * 3600 * 1000));
}

const findings = [];
const failures = [];
const truncated = [];
const seenPrs = new Set(); // "owner/repo#number" — この run で実際に確認できた PR

// 前回の全体一覧に載っていた PR を読み戻す（持ち越しの入力）。
function loadCarriedPrs(path) {
  if (!existsSync(path)) return [];
  const out = new Map();
  for (const m of readFileSync(path, 'utf8').matchAll(
    /https:\/\/github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/pull\/(\d+)/g,
  )) {
    const repo = `${m[1]}/${m[2]}`;
    const number = Number(m[3]);
    out.set(`${repo}#${number}`, { repo, number });
  }
  return [...out.values()];
}

// 1つの PR ノードから未 resolve な Codex 指摘を取り出す
function collectFromPr(repo, pr) {
  if (!pr) return 0;
  seenPrs.add(`${repo}#${pr.number}`);
  if (pr.reviewThreads?.pageInfo?.hasNextPage) truncated.push(`${repo}#${pr.number}`);
  let found = 0;
  for (const th of pr.reviewThreads?.nodes || []) {
    if (!th || th.isResolved) continue;
    const c = th.comments?.nodes?.[0];
    if (!c || c.author?.login !== bot) continue;
    const { priority, title } = parseFinding(c.body || '');
    findings.push({
      repo,
      pr: pr.number,
      prMerged: pr.merged,
      priority,
      title,
      path: c.path || '',
      url: c.url,
      createdAt: c.createdAt,
      isOutdated: th.isOutdated,
    });
    found++;
  }
  return found;
}

const carried = loadCarriedPrs(outAll);

for (const repo of repos) {
  const [owner, name] = repo.split('/');
  let scanned = 0;
  let found = 0;
  let after = null;
  let pages = 0;
  let reachedCutoff = false;
  let failed = false;

  while (pages < MAX_PAGES && !reachedCutoff) {
    let data;
    try {
      data = await graphql(QUERY, { owner, name, after });
    } catch (err) {
      failures.push({ repo, reason: String(err.message || err) });
      console.log(`repo=${repo} status=error page=${pages}`);
      failed = true;
      break;
    }
    pages++;
    const conn = data.pullRequests;
    for (const pr of conn?.nodes || []) {
      if (!pr) continue;
      if (new Date(pr.updatedAt) < cutoff) {
        reachedCutoff = true; // UPDATED_AT desc なのでここから先は全部古い
        break;
      }
      scanned++;
      found += collectFromPr(repo, pr);
    }
    if (!conn?.pageInfo?.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }

  if (failed) continue;
  // 上限に当たった＝lookback 期間を見切れていない。黙って諦めず一覧に残す。
  if (pages >= MAX_PAGES && !reachedCutoff) {
    failures.push({ repo, reason: `scan truncated at ${MAX_PAGES} pages (lookback not fully covered)` });
  }
  console.log(`repo=${repo} status=ok pages=${pages} prs_scanned=${scanned} open_findings=${found}`);
}

// 前回載っていて今回のスキャン窓から外れた PR を名指しで再確認する
let carriedChecked = 0;
let carriedFound = 0;
for (const { repo, number } of carried) {
  if (seenPrs.has(`${repo}#${number}`)) continue;
  const [owner, name] = repo.split('/');
  let data;
  try {
    data = await graphql(PR_QUERY, { owner, name, number });
  } catch (err) {
    // **落ちたら消さない**。読めなかった PR を黙って落とすと持ち越しの意味が無くなる。
    failures.push({ repo: `${repo}#${number}`, reason: `carried-over: ${String(err.message || err)}` });
    continue;
  }
  carriedChecked++;
  carriedFound += collectFromPr(repo, data.pullRequest);
}
if (carriedChecked || carried.length) {
  console.log(`carried_over prs_rechecked=${carriedChecked} open_findings=${carriedFound}`);
}

// 並びを決定的にする（毎 run 同じ内容なら同じバイト列になり、無駄なコミットが立たない）。
// 危険度の高い順: マージ済み PR に未 resolve で残っているもの → P1 → 古い順。
const priorityRank = (p) => (p === 'P1' ? 0 : p === 'P2' ? 1 : p === 'P3' ? 2 : 3);
const bySeverity = (a, b) =>
  Number(b.prMerged) - Number(a.prMerged) ||
  priorityRank(a.priority) - priorityRank(b.priority) ||
  a.createdAt.localeCompare(b.createdAt) ||
  a.repo.localeCompare(b.repo) ||
  a.pr - b.pr ||
  a.url.localeCompare(b.url);
findings.sort(bySeverity);
failures.sort((a, b) => a.repo.localeCompare(b.repo));

const STAMP = '<!-- generated:PLACEHOLDER -->';
const esc = (s) => String(s).replace(/\|/g, '\\|');

function headerLines(scope) {
  return [
    `# Codex レビューの未対応在庫${scope}`,
    '',
    'ops-sync の `codex-review-inbox` workflow が生成する。**手で編集しない**（次回実行で上書きされる）。',
    '生成元: `ops-sync/scripts/codex-review-inbox.mjs`。',
    '',
    '**この一覧は GitHub の resolve 状態そのもの**なので、別途の管理表は無い:',
    '',
    '1. 指摘を直す（配布 doc・共有ファイルの指摘は **ops-sync の正本で直す**。consumer 同期 PR は手編集しない）',
    '2. GitHub でそのレビュースレッドを **resolve** する',
    '3. 次回実行でこの一覧から消える',
    '',
    '対応しない判断をした場合も、理由を返信してから resolve する（放置＝この一覧に残り続ける）。',
    '',
  ];
}

function tableLines(items) {
  const out = ['| | 優先 | PR | ファイル | 指摘 | 経過 |', '|---|---|---|---|---|---|'];
  for (const f of items) {
    out.push(
      `| ${f.prMerged ? '🔴' : '🟡'} | ${f.priority} | [#${f.pr}](${f.url}) | \`${esc(f.path || '—')}\` |` +
        ` ${esc(f.title)}${f.isOutdated ? ' _(outdated)_' : ''} | ${daysAgo(f.createdAt)}日 |`,
    );
  }
  out.push('');
  out.push('🔴 = マージ済み PR の未 resolve（配布物なら全 consumer に欠陥が残っている状態＝最優先）／🟡 = open PR。');
  out.push('');
  return out;
}

function failureLines(items) {
  if (!items.length) return [];
  return [
    '## ⚠️ 取得できなかったもの',
    '',
    'この分は**未確認**（指摘が無いという意味ではない）。トークンの権限・API 障害・走査上限を疑う。',
    '',
    '| 対象 | 理由 |',
    '|---|---|',
    ...items.map((f) => `| \`${f.repo}\` | ${esc(f.reason)} |`),
    '',
  ];
}

function footerLines(extra) {
  return [
    '---',
    '',
    ...extra,
    `走査対象: ${repos.map((r) => `\`${r}\``).join(' / ')}。直近 ${lookbackDays} 日に更新された PR に加え、` +
      '**前回この一覧に載っていた PR は窓の外でも名指しで再確認する**' +
      '（＝古くなったからではなく、resolve されたから消える）。',
    ...(truncated.length
      ? ['', `> 注: 次の PR はレビュースレッドが多く、一部を読み切れていない: ${truncated.join(', ')}`]
      : []),
    '',
    STAMP,
  ];
}

// **生成時刻だけの差分では書き換えない**（15分ごとに走るので、毎回コミットすると履歴が埋まる）。
let filesChanged = 0;
function writeIfChanged(path, bodyLines) {
  const stamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const content = `${bodyLines.join('\n').replace(STAMP, `<!-- generated:${stamp} -->`)}\n`;
  const strip = (s) => s.replace(/<!-- generated:[^>]*-->/, '<!-- generated -->');
  if (existsSync(path) && strip(readFileSync(path, 'utf8')) === strip(content)) return false;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  filesChanged++;
  return true;
}

// ── 全体一覧（private にだけ置く。リポジトリごとにグループ化＋コピペ用の依頼文つき）────────────
const mergedCount = findings.filter((f) => f.prMerged).length;
const all = [...headerLines('（全リポジトリ）')];

all.push(...failureLines(failures));
all.push(`## 未対応 ${findings.length} 件`);
all.push('');
if (findings.length === 0) {
  all.push('未 resolve の Codex 指摘はありません。');
  all.push('');
} else {
  if (mergedCount > 0) {
    all.push(`そのうち **${mergedCount} 件はマージ済み PR** に残っている（🔴）。`);
    all.push('');
  }
  for (const repo of repos) {
    const mine = findings.filter((f) => f.repo === repo);
    if (!mine.length) continue;
    const short = repo.split('/')[1];
    const red = mine.filter((f) => f.prMerged).length;
    all.push(`### \`${short}\` — ${mine.length}件（🔴 ${red} / 🟡 ${mine.length - red}）`);
    all.push('');
    all.push('そのリポジトリのセッションに貼る依頼文:');
    all.push('');
    all.push('```');
    all.push(`${short} の Codex 指摘の積み残しを消化する`);
    all.push(
      '`.ops-sync/codex-review-inbox.md` にこのリポジトリ分の未対応一覧があります。' +
        '読んで対応し、直したらレビュースレッドを resolve してください。',
    );
    all.push('```');
    all.push('');
    all.push(...tableLines(mine));
  }
}
all.push(
  ...footerLines([
    '各リポジトリには**そのリポジトリの分だけ**を抜き出した `.ops-sync/codex-review-inbox.md` も置いてある',
    '（どのエージェントでも自分の作業リポジトリで自分の積み残しを読める）。この全体一覧はここにしか無い。',
    '',
  ]),
);
writeIfChanged(outAll, all);

// ── リポジトリごとのスライス（各リポジトリの .ops-sync/ に置く）────────────────────────────
for (const repo of repos) {
  const mine = findings.filter((f) => f.repo === repo);
  // そのリポジトリ自身の取得失敗だけを載せる（他リポジトリの事情を持ち込まない）
  const myFailures = failures.filter((f) => f.repo === repo || f.repo.startsWith(`${repo}#`));
  const short = repo.split('/')[1];
  const lines = [...headerLines(`（\`${short}\`）`)];
  lines.push(...failureLines(myFailures));
  lines.push(`## 未対応 ${mine.length} 件`);
  lines.push('');
  if (mine.length === 0) {
    lines.push('このリポジトリに未 resolve の Codex 指摘はありません。');
    lines.push('');
  } else {
    lines.push(...tableLines(mine));
  }
  lines.push(...footerLines([`これは \`${repo}\` の分だけを抜き出したもの。全リポジトリ分の一覧は別にある。`, '']));
  writeIfChanged(join(clonesDir, repo, '.ops-sync', 'codex-review-inbox.md'), lines);
}

console.log(
  `summary repos=${repos.length} failures=${failures.length} open_findings=${findings.length} ` +
    `merged_unresolved=${mergedCount} files_changed=${filesChanged} lookback_days=${lookbackDays} ` +
    `ratelimit_remaining=${rate?.remaining ?? '?'}`,
);

setOutput('open_findings', String(findings.length));
setOutput('merged_unresolved', String(mergedCount));
setOutput('failures', String(failures.length));
setOutput('files_changed', String(filesChanged));
