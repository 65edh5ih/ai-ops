// Codex レビュー指摘の「未対応在庫」を全リポジトリから集めて1つの一覧に落とす。
//
// なぜ必要か: Codex のレビューは**同期 PR がマージされた数分後**に付くことがあり（実測: 07:39 マージ →
// 07:41 レビュー）、そのときレビューを出した側のセッションはもう終わっている。メール通知を1件ずつ
// 辿って「これは対応済みか？」を人が確認する運用になっていて、取りこぼしが常態化していた。配布物
// （shared/ の共通 doc・composite action）への指摘を取りこぼすと、欠陥が全 consumer に残る。
//
// 設計の要点: **状態を持たない**。「未 resolve の Codex レビュースレッド」そのものをキューとして扱う。
//   未対応 → 一覧に載る／対応して resolve → 次の run で消える。
// 別途の管理表を持たないので、一覧と実態がずれない。
//
// 入力（環境変数）:
//   CRI_TOKEN          GitHub トークン（対象リポジトリの Pull requests: read が要る）
//   CRI_REPOS          走査対象。`owner/repo` を改行か空白区切りで。`#` 始まりの行は無視
//   CRI_OUTPUT         出力先ファイルパス（対象リポジトリのクローン内）
//   CRI_LOOKBACK_DAYS  この日数より古い更新の PR は見ない。既定 30
//   CRI_BOT            Codex のレビュー投稿者ログイン。既定 chatgpt-codex-connector
//
// 出力: <CRI_OUTPUT>（markdown）と stdout のサマリ。
//   **stdout は ops-sync の ci-logs（世界公開）に載るので、件数と repo 名しか出さない**（MUST NOT:
//   指摘本文・パスをログに出す。private リポジトリの内容が公開に落ちる）。一覧ファイル自身は private
//   リポジトリにだけ書くので、そちらには指摘の見出しを載せてよい。
//
// 終了コード: 常に 0。取得に失敗したリポジトリは一覧に「取得失敗」行として**残す**（黙って短い一覧を
// 出すと、指摘が消えたのか読めなかったのか区別できず fail-open になる）。

const GRAPHQL = 'https://api.github.com/graphql';

const token = process.env.CRI_TOKEN || '';
const outPath = process.env.CRI_OUTPUT || '';
const bot = process.env.CRI_BOT || 'chatgpt-codex-connector';

// 壊れた値で走査範囲が 0 日になると「指摘ゼロ」を出してしまう（fail-open）ので、妥当でなければ既定に倒す。
const rawLookback = process.env.CRI_LOOKBACK_DAYS ?? '30';
const parsedLookback = Number(rawLookback);
const lookbackDays =
  Number.isFinite(parsedLookback) && parsedLookback >= 1 && parsedLookback <= 365 ? parsedLookback : 30;

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
const { dirname } = await import('node:path');

function setOutput(key, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  appendFileSync(file, `${key}=${value}\n`);
}

if (!token || !outPath || repos.length === 0) {
  console.log('codex-review-inbox: missing CRI_TOKEN / CRI_OUTPUT / CRI_REPOS; nothing to do');
  setOutput('changed', 'false');
  setOutput('open_findings', '0');
  process.exit(0);
}

const cutoff = new Date(Date.now() - lookbackDays * 24 * 3600 * 1000);

const QUERY = `
query($owner:String!,$name:String!){
  repository(owner:$owner,name:$name){
    pullRequests(first:50, orderBy:{field:UPDATED_AT,direction:DESC}){
      nodes{
        number url title state merged updatedAt
        reviewThreads(first:50){
          pageInfo{ hasNextPage }
          nodes{
            isResolved isOutdated
            comments(first:1){
              nodes{ author{ login } createdAt url path body }
            }
          }
        }
      }
    }
  }
}`;

async function graphql(owner, name) {
  const res = await fetch(GRAPHQL, {
    method: 'POST',
    headers: {
      authorization: `bearer ${token}`,
      'content-type': 'application/json',
      'user-agent': 'ops-sync-codex-review-inbox',
    },
    body: JSON.stringify({ query: QUERY, variables: { owner, name } }),
  });
  if (!res.ok) throw new Error(`http ${res.status}`);
  const json = await res.json();
  // GraphQL は HTTP 200 でも errors を返す。ここで落とさないと「指摘ゼロ」として扱ってしまう。
  if (json.errors?.length) throw new Error(json.errors.map((e) => e.type || e.message).join(','));
  if (!json.data?.repository) throw new Error('no repository in response');
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

for (const repo of repos) {
  const [owner, name] = repo.split('/');
  if (!owner || !name) {
    failures.push({ repo, reason: 'invalid repo spec' });
    continue;
  }
  let data;
  try {
    data = await graphql(owner, name);
  } catch (err) {
    failures.push({ repo, reason: String(err.message || err) });
    console.log(`repo=${repo} status=error`);
    continue;
  }

  let scanned = 0;
  let found = 0;
  for (const pr of data.pullRequests?.nodes || []) {
    if (!pr) continue;
    if (new Date(pr.updatedAt) < cutoff) break; // UPDATED_AT desc なのでここから先は全部古い
    scanned++;
    if (pr.reviewThreads?.pageInfo?.hasNextPage) truncated.push(`${repo}#${pr.number}`);
    for (const th of pr.reviewThreads?.nodes || []) {
      if (!th || th.isResolved) continue;
      const c = th.comments?.nodes?.[0];
      if (!c || c.author?.login !== bot) continue;
      const { priority, title } = parseFinding(c.body || '');
      findings.push({
        repo,
        pr: pr.number,
        prMerged: pr.merged,
        prState: pr.state,
        priority,
        title,
        path: c.path || '',
        url: c.url,
        createdAt: c.createdAt,
        isOutdated: th.isOutdated,
      });
      found++;
    }
  }
  console.log(`repo=${repo} status=ok prs_scanned=${scanned} open_findings=${found}`);
}

// 並びを決定的にする（毎 run 同じ内容なら同じバイト列になり、無駄なコミットが立たない）。
// 危険度の高い順: マージ済み PR に未 resolve で残っているもの → P1 → 古い順。
const priorityRank = (p) => (p === 'P1' ? 0 : p === 'P2' ? 1 : p === 'P3' ? 2 : 3);
findings.sort(
  (a, b) =>
    Number(b.prMerged) - Number(a.prMerged) ||
    priorityRank(a.priority) - priorityRank(b.priority) ||
    a.createdAt.localeCompare(b.createdAt) ||
    a.repo.localeCompare(b.repo) ||
    a.pr - b.pr ||
    a.url.localeCompare(b.url),
);
failures.sort((a, b) => a.repo.localeCompare(b.repo));

const lines = [];
lines.push('# Codex レビューの未対応在庫（自動生成）');
lines.push('');
lines.push('ops-sync の `codex-review-inbox` workflow が全リポジトリを走査して生成する。**手で編集しない**');
lines.push('（次回実行で上書きされる）。生成元: `ops-sync/scripts/codex-review-inbox.mjs`。');
lines.push('');
lines.push('**この一覧は GitHub の resolve 状態そのもの**なので、別途の管理表は無い:');
lines.push('');
lines.push('1. 指摘を直す（配布 doc・共有ファイルの指摘は **ops-sync の正本で直す**。consumer 同期 PR は手編集しない）');
lines.push('2. GitHub でそのレビュースレッドを **resolve** する');
lines.push('3. 次回実行でこの一覧から消える');
lines.push('');
lines.push('対応しない判断をした場合も、理由を返信してから resolve する（放置＝この一覧に残り続ける）。');
lines.push('');

if (failures.length) {
  lines.push('## ⚠️ 取得できなかったリポジトリ');
  lines.push('');
  lines.push('このリポジトリ分は**未確認**（指摘が無いという意味ではない）。トークンの権限・API 障害を疑う。');
  lines.push('');
  lines.push('| リポジトリ | 理由 |');
  lines.push('|---|---|');
  for (const f of failures) lines.push(`| \`${f.repo}\` | ${f.reason.replace(/\|/g, '\\|')} |`);
  lines.push('');
}

const mergedCount = findings.filter((f) => f.prMerged).length;

lines.push(`## 未対応 ${findings.length} 件`);
lines.push('');
if (findings.length === 0) {
  lines.push('未 resolve の Codex 指摘はありません。');
  lines.push('');
} else {
  if (mergedCount > 0) {
    lines.push(
      `そのうち **${mergedCount} 件はマージ済み PR** に残っている（＝指摘された変更がすでに入っている状態。` +
        '配布物なら全 consumer に欠陥が残るので最優先）。',
    );
    lines.push('');
  }
  lines.push('| | 優先 | リポジトリ | PR | ファイル | 指摘 | 経過 |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const f of findings) {
    const flag = f.prMerged ? '🔴' : '🟡';
    const title = f.title.replace(/\|/g, '\\|');
    const path = (f.path || '—').replace(/\|/g, '\\|');
    lines.push(
      `| ${flag} | ${f.priority} | \`${f.repo.split('/')[1]}\` | [#${f.pr}](${f.url}) | \`${path}\` |` +
        ` ${title}${f.isOutdated ? ' _(outdated)_' : ''} | ${daysAgo(f.createdAt)}日 |`,
    );
  }
  lines.push('');
  lines.push('🔴 = マージ済み PR の未 resolve／🟡 = open PR の未 resolve。');
  lines.push('');
}

lines.push('---');
lines.push('');
lines.push(`走査対象: ${repos.map((r) => `\`${r}\``).join(' / ')}（直近 ${lookbackDays} 日に更新された PR）`);
if (truncated.length) {
  lines.push('');
  lines.push(`> 注: 次の PR はレビュースレッドが多く、一部を読み切れていない: ${truncated.join(', ')}`);
}
lines.push('');
lines.push('<!-- generated:PLACEHOLDER -->');

const stamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const bodyWithoutStamp = lines.join('\n');
const content = `${bodyWithoutStamp.replace('<!-- generated:PLACEHOLDER -->', `<!-- generated:${stamp} -->`)}\n`;

// **生成時刻だけの差分でコミットしない**（15分ごとに走るので、毎回コミットすると履歴が埋まる）。
// 時刻行を除いた本文で比較し、実質的な変化があるときだけ書き出す。
let changed = true;
if (existsSync(outPath)) {
  const prev = readFileSync(outPath, 'utf8');
  const strip = (s) => s.replace(/<!-- generated:[^>]*-->/, '<!-- generated -->');
  changed = strip(prev) !== strip(content);
}

if (changed) {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, content);
}

console.log(
  `summary repos=${repos.length} failures=${failures.length} open_findings=${findings.length} ` +
    `merged_unresolved=${mergedCount} changed=${changed}`,
);

setOutput('changed', String(changed));
setOutput('open_findings', String(findings.length));
setOutput('merged_unresolved', String(mergedCount));
setOutput('failures', String(failures.length));
