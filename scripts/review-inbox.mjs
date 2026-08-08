// レビュー指摘の「未対応在庫」を全リポジトリから集め、全体一覧＋リポジトリごとのスライスに落とす。
//
// なぜ必要か: レビューは同期 PR がマージされた数分後に届くことがあり、そのとき配布変更を出した
// セッションは終わっている。ops-sync 本体の PR には出ず consumer 同期 PR にだけ出る指摘もあるため、
// 気づくには全リポジトリを見る必要がある。配布物（shared/）への指摘を取りこぼすと欠陥が全 consumer に残る。
//
// 設計の要点:
//   - **投稿者で選別しない**。未 resolve のレビュースレッドは、書いたのが誰であれ在庫に載せる。
//     理由は2つ。①在庫の原則（未 resolve のスレッド1本＝誰も見ていない欠陥1件）は投稿者に依存しない。
//     ②**そもそも投稿者では分けられない**——Codex は専用の bot login を持つが、Claude Code が
//     `/code-review --comment` で投稿する指摘の author は**オーナー本人の login**（セッションのトークンの
//     identity）で、人間が書いたコメントや PR 作成者と区別が付かない。許可リスト方式にすると、
//     分離できない投稿者を「足したつもり」で落とし続けることになる。
//     レビュアーが増えても（Copilot 等）コード変更なしで拾えるのも同じ理由による副次効果。
//     絞りたいときだけ RI_REVIEWERS に login を列挙する（既定は全員）。
//   - **状態を持たない**。「未 resolve のレビュースレッド」そのものがキュー。
//     未対応 → 一覧に載る／対応して resolve → 次の run で消える。別途の管理表を持たないのでずれない。
//   - **消える条件は「resolve された」だけ**。直近スキャンの窓から外れただけで消えないよう、前回の全体
//     一覧に載っていた PR は名指しで再確認する（持ち越し）。前回の出力が持ち越しの入力を兼ねる。
//   - **読めなかったものは落とさない**。取得に失敗したリポジトリ・PR、および**レビュースレッドを
//     1ページ（50件）で読み切れなかった PR** は「取得失敗」行として残す（黙って短い一覧を出すと、
//     指摘が消えたのか読めなかったのか区別できず fail-open になる）。workflow はこの件数で run を
//     失敗させるので、読み残しは緑にならない。
//   - **マージされずクローズされた PR は在庫に載せない**。その変更は `main` に入っていないので直す対象が
//     無く、載せると「理由を返信して resolve」という実コストだけが必ず発生する（消化プロトコルは
//     全件を決着させることを要求する）。放棄された PR は増え続けるため、載せ続けると表が死に行で埋まって
//     読まれなくなる——それがこの一覧の最悪の壊れ方。ただし**黙って消しはしない**: 直近スキャンで
//     見つけた分だけ件数を注記に出す（放棄された PR の指摘が `main` にも当てはまることがあり、人が
//     気づく余地を残す）。注記は**持ち越しの対象外**で、窓から外れれば消える（＝単調増加しない）。
//     reopen されれば updatedAt が動くので直近スキャンが拾い直す。
//
// 入力（環境変数）:
//   RI_TOKEN          GitHub トークン（対象リポジトリの Pull requests: read が要る）
//   RI_REPOS          走査対象。`owner/repo` を改行か空白区切りで。`#` 以降はコメント
//   RI_CLONES         各リポジトリのクローンを置いたディレクトリ。スライスは
//                     <RI_CLONES>/<owner>/<repo>/.ops-sync/review-inbox.md へ書く
//   RI_OUT_ALL        全体一覧の出力先パス（**private リポジトリのクローン内**）
//   RI_SLICE_REPOS    リポジトリ別スライスを書き出す対象。未指定なら RI_REPOS 全件。
//                     public repo の main を PR 必須で保護するときは除外し、全体一覧だけに載せる。
//   RI_LOOKBACK_DAYS  この日数より古い更新の PR は直近スキャンで見ない。既定 3
//                     直近スキャンの役目は**新しい指摘の発見**だけでよい（レビューは PR イベントの数分後に
//                     届き、この workflow は毎時回る）。一度載ったものは持ち越しが resolve まで
//                     守るので、窓を広く取る必要はない。窓を広げるほど GraphQL のレート消費が増える
//                     （PR の多い consumer は30日で500 PR 超＝10ページ超）。過去分を洗い直したいときだけ
//                     workflow_dispatch で大きい値を渡して1回流す。
//   RI_REVIEWERS      在庫に載せるレビュー投稿者の login を空白/カンマ区切りで列挙する**絞り込み**。
//                     **既定は空＝全員**（→ 冒頭「投稿者で選別しない」）。特定のレビュアーだけを見たい
//                     ときの一時的な緊急弁として残してある。
//
// 出力:
//   - <RI_OUT_ALL> … 全リポジトリ分。**リポジトリごとにグループ化**し、各グループにセッションへ貼る
//     コピペ用の依頼文を添える。全リポジトリの内容が混ざるので private リポジトリにだけ置く。
//   - RI_SLICE_REPOS の `.ops-sync/review-inbox.md` … **そのリポジトリの分だけ**。
//     private consumer のエージェントが API アクセス無しで自分の積み残しを読める。public repo は
//     PR 必須の main へ直接 push せず、private の全体一覧だけに載せる。
//   - stdout のサマリ。**ops-sync の ci-logs（世界公開）に載るので、件数と repo 名しか出さない**
//     （MUST NOT: 指摘本文・パスをログに出す。private リポジトリの内容が公開に落ちる）。
//   - outputs。`merged_unresolved`（マージ済み PR に残っている件数）と `merged_unresolved_repos`
//     （その repo 名）は、workflow が run を失敗させる判定に使う。一覧に積むだけでは
//     **誰も見に行かない限り気づけない**ため（→ workflow の「Flag …」ステップ）。
//
// 終了コード: 常に 0（失敗判定は workflow 側で行う。ここで落とすと一覧の書き出しが飛ぶ）。
//
// 内容が実質変わらないファイルは書き換えない（生成時刻だけの差分でコミットが立たないように）。

const GRAPHQL = 'https://api.github.com/graphql';
const MAX_PAGES = 20; // 直近スキャンのページ上限（1ページ50件）。cutoff に届く前の暴走を防ぐ安全弁

const token = process.env.RI_TOKEN || '';
const clonesDir = process.env.RI_CLONES || '';
const outAll = process.env.RI_OUT_ALL || '';

// 投稿者の絞り込み。**空＝全員**（既定）。→ 冒頭「投稿者で選別しない」
const reviewerFilter = new Set(
  (process.env.RI_REVIEWERS || '')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean),
);
// author が取れないスレッド（アカウント削除等）も**落とさない**。未 resolve であることは変わらず、
// 落とすと「読めなかった」と「指摘が無い」が区別できなくなる（この一覧が防ぐはずの fail-open）。
const UNKNOWN_REVIEWER = '(unknown)';
const acceptsReviewer = (login) => reviewerFilter.size === 0 || reviewerFilter.has(login);

// 壊れた値で走査範囲が 0 日になると「指摘ゼロ」を出してしまう（fail-open）ので、妥当でなければ既定に倒す。
const rawLookback = process.env.RI_LOOKBACK_DAYS || '3';
const parsedLookback = Number(rawLookback);
const lookbackDays =
  Number.isFinite(parsedLookback) && parsedLookback >= 1 && parsedLookback <= 365 ? parsedLookback : 3;

// consumers.txt をそのまま渡せるようにする: `#` 以降はコメント、1行に1つの `owner/repo`。
// **行単位で先にコメントを落とす**（空白で分割してから `#` を弾くと、`# 計算基盤` のような
// コメント行の2語目が repo 名として残る）。形が `owner/repo` でないものは無視する。
const REPO_SHAPE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const repos = (process.env.RI_REPOS || '')
  .split(/\r?\n/)
  .map((line) => line.replace(/#.*$/, '').trim())
  .flatMap((line) => line.split(/[\s,]+/))
  .map((s) => s.trim())
  .filter((s) => REPO_SHAPE.test(s));
const repoSet = new Set(repos);
const sliceRepos = (process.env.RI_SLICE_REPOS === undefined ? process.env.RI_REPOS || '' : process.env.RI_SLICE_REPOS)
  .split(/\r?\n/)
  .map((line) => line.replace(/#.*$/, '').trim())
  .flatMap((line) => line.split(/[\s,]+/))
  .map((s) => s.trim())
  .filter((s) => REPO_SHAPE.test(s) && repoSet.has(s));
const sliceRepoSet = new Set(sliceRepos);

const { writeFileSync, readFileSync, existsSync, mkdirSync, appendFileSync, unlinkSync } = await import('node:fs');
const { dirname, join } = await import('node:path');

// 旧名（`codex-` 接頭辞つき）の生成物。**この一覧は sync-manifest の管理下に無く、この workflow が
// consumer の main へ直接 push している**ので、改名しても旧ファイルは消えずに残り続ける（新旧2つの
// 在庫が並ぶ＝どちらが現行か読めない）。書き出しのたびに旧名を消して回る。
const LEGACY_ALL_BASENAME = 'codex-review-inbox-all.md';
const LEGACY_SLICE_BASENAME = 'codex-review-inbox.md';

function setOutput(key, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  appendFileSync(file, `${key}=${value}\n`);
}

if (!token || !outAll || !clonesDir || repos.length === 0) {
  console.log('review-inbox: missing RI_TOKEN / RI_OUT_ALL / RI_CLONES / RI_REPOS; nothing to do');
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

// 直近の rateLimit 観測値（GraphQL は 5,000 ポイント/時。定期的に回すので消費を見えるようにしておく）
let rate = null;

async function graphql(query, variables) {
  const res = await fetch(GRAPHQL, {
    method: 'POST',
    headers: {
      authorization: `bearer ${token}`,
      'content-type': 'application/json',
      'user-agent': 'ops-sync-review-inbox',
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

// 見出しと優先度だけ取り出す（本文全体は載せない——リンク先で読める）。
//
// 優先度バッジ `![P2 Badge](...)` は **Codex 固有の書式**。他のレビュアーの指摘には付かないので `--` になる。
// **`--` は「優先度なし」であって「低い」ではない**（表の注記でも同じことを言う）。並び順では未知扱いで
// 最後に落ちるが、それは危険度の判定ではなく決定的な並びを作るための既定。
// 見出しは「最初の太字」→無ければ「最初の非空行」の順に拾う（markdown の飾りは落とす）。
function parseFinding(body) {
  const priority = body.match(/!\[(P[0-9])\s+Badge\]/)?.[1] || '--';
  const firstBold = body.match(/\*\*(?:<sub>|<\/sub>|!\[[^\]]*\]\([^)]*\))*\s*([^*]+?)\s*\*\*/);
  const firstLine = (body.split('\n').find((l) => l.trim()) || '').replace(/^\s*[#>*\-\s]+/, '');
  const title = (firstBold?.[1] || firstLine).replace(/\s+/g, ' ').trim();
  return { priority, title: title.slice(0, 160) };
}

function daysAgo(iso) {
  return Math.floor((Date.now() - new Date(iso).getTime()) / (24 * 3600 * 1000));
}

const findings = [];
const abandoned = []; // マージされずクローズされた PR の未 resolve（在庫の対象外・注記だけ出す）
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

// 1つの PR ノードから未 resolve なレビュー指摘を取り出す。
// viaCarry: 持ち越し（前回の一覧に載っていたので名指しで再確認した）経由かどうか。
function collectFromPr(repo, pr, viaCarry = false) {
  if (!pr) return 0;
  seenPrs.add(`${repo}#${pr.number}`);
  // マージされずクローズされた PR は在庫に載せない（→ 冒頭「設計の要点」）。
  // 注記に出すのは**直近スキャンで見つけた分だけ**。持ち越し経由のものを注記に出すと、注記のリンクが
  // 次回の持ち越し入力になって永久に残る（在庫から外した意味が無くなる）。
  if (!pr.merged && pr.state === 'CLOSED') {
    if (viaCarry) return 0;
    // 読み切れなかったスレッドも「取得失敗」にしない: 対象外の PR を読み残しても直す先が無く、
    // run を赤くしても誰も動けない（読み残しで赤くするのは在庫に載るクラスだけでよい）。
    const count = (pr.reviewThreads?.nodes || []).filter(
      (th) =>
        th &&
        !th.isResolved &&
        th.comments?.nodes?.[0] &&
        acceptsReviewer(th.comments.nodes[0].author?.login || UNKNOWN_REVIEWER),
    ).length;
    if (count) abandoned.push({ repo, pr: pr.number, url: pr.url, count });
    return 0;
  }
  // レビュースレッドが1ページ（50件）に収まらない PR は、2ページ目以降を**見ていない**。
  // 注記だけ出して緑で流すと「指摘ゼロ」と「読み切れていない」が区別できず、この一覧が防ぐはずの
  // fail-open そのものになる（workflow はこの failures の件数で run を失敗させる）。
  if (pr.reviewThreads?.pageInfo?.hasNextPage) {
    truncated.push(`${repo}#${pr.number}`);
    failures.push({
      repo: `${repo}#${pr.number}`,
      reason: 'review threads exceed one page (50); later pages were not inspected',
    });
  }
  let found = 0;
  for (const th of pr.reviewThreads?.nodes || []) {
    if (!th || th.isResolved) continue;
    const c = th.comments?.nodes?.[0];
    if (!c) continue;
    const reviewer = c.author?.login || UNKNOWN_REVIEWER;
    if (!acceptsReviewer(reviewer)) continue;
    const { priority, title } = parseFinding(c.body || '');
    findings.push({
      repo,
      pr: pr.number,
      prMerged: pr.merged,
      reviewer,
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

// 改名の初回実行では新パスがまだ無い。旧名から読み戻さないと**持ち越しが1回だけ全滅**し、
// 「窓の外に出ただけの未 resolve」が静かに在庫から消える（resolve されたから消える、が崩れる）。
const carried = loadCarriedPrs(existsSync(outAll) ? outAll : join(dirname(outAll), LEGACY_ALL_BASENAME));

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
  carriedFound += collectFromPr(repo, data.pullRequest, true);
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
abandoned.sort((a, b) => a.repo.localeCompare(b.repo) || a.pr - b.pr);

const STAMP = '<!-- generated:PLACEHOLDER -->';
const esc = (s) => String(s).replace(/\|/g, '\\|');

function headerLines(scope) {
  return [
    `# レビューの未対応在庫${scope}`,
    '',
    'ops-sync の `review-inbox` workflow が生成する。**手で編集しない**（次回実行で上書きされる）。',
    '生成元: `ops-sync/scripts/review-inbox.mjs`。**投稿者を問わず**未 resolve のレビュースレッドを全部載せる。',
    '',
    '**この一覧は GitHub の resolve 状態そのもの**なので、別途の管理表は無い:',
    '',
    '1. 指摘を直す（配布 doc・共有ファイルの指摘は **ops-sync の正本で直す**。consumer 同期 PR は手編集しない）',
    '2. GitHub でそのレビュースレッドを **resolve** する',
    '3. 次回実行でこの一覧から消える',
    '',
    '対応しない判断をした場合も、理由を返信してから resolve する（放置＝この一覧に残り続ける）。',
    'ただし**マージされずクローズされた PR の指摘は対象外**（その変更は `main` に入っていないので直す先が無い）。',
    '',
  ];
}

function tableLines(items) {
  const out = ['| | 優先 | PR | レビュアー | ファイル | 指摘 | 経過 |', '|---|---|---|---|---|---|---|'];
  for (const f of items) {
    out.push(
      `| ${f.prMerged ? '🔴' : '🟡'} | ${f.priority} | [#${f.pr}](${f.url}) | ${esc(f.reviewer)} |` +
        ` \`${esc(f.path || '—')}\` | ${esc(f.title)}${f.isOutdated ? ' _(outdated)_' : ''} | ${daysAgo(f.createdAt)}日 |`,
    );
  }
  out.push('');
  out.push('🔴 = マージ済み PR の未 resolve（配布物なら全 consumer に欠陥が残っている状態＝最優先）／🟡 = open PR。');
  out.push(
    '優先度 `--` は**優先度なし**（低い、ではない）。`P1`〜`P3` のバッジは Codex 固有の書式で、' +
      '他のレビュアーの指摘には付かない。',
  );
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

// マージされずクローズされた PR の未 resolve。**在庫（表）には載せず、ここで件数だけ知らせる**。
// 直す対象が `main` に無いので resolve 不要だが、同じ問題が `main` にも当てはまることがあるため、
// 黙って消さずに人が気づける形で残す（→ 冒頭「設計の要点」）。
function abandonedLines(items) {
  if (!items.length) return [];
  const total = items.reduce((n, a) => n + a.count, 0);
  return [
    '## ⚪ 対象外: クローズ済み（未マージ）PR',
    '',
    `マージされずクローズされた PR に未 resolve の指摘が **${total} 件**残っている。その変更は \`main\` に` +
      '入っていないので**上の在庫の対象外**（resolve しなくてよい）。',
    '同じ問題が `main` にも当てはまるときだけ、現在の正本を見たうえで別途拾う。',
    '',
    ...items.map((a) => `- \`${a.repo.split('/')[1]}\` [#${a.pr}](${a.url}) — ${a.count}件`),
    '',
    `直近 ${lookbackDays} 日に更新された PR から拾った分だけを載せる（持ち越しの対象外なので、` +
      '窓から外れれば消える。reopen されれば直近スキャンが拾い直す）。',
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

// **生成時刻だけの差分では書き換えない**（定期的に走るので、毎回コミットすると履歴が埋まる）。
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

// 旧名の生成物を消す（→ LEGACY_* 定義のコメント）。消した分も filesChanged に数える——
// 数えないと「内容に変化なし」で commit ステップごと飛ばされ、旧ファイルが consumer に残り続ける。
function removeLegacy(dir, basename) {
  const path = join(dir, basename);
  if (!existsSync(path)) return false;
  unlinkSync(path);
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
  all.push('未 resolve のレビュー指摘はありません。');
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
    all.push(`${short} のレビュー指摘の積み残しを消化する`);
    all.push(
      sliceRepoSet.has(repo)
        ? '`.ops-sync/review-inbox.md` にこのリポジトリ分の未対応一覧があります。' +
            '読んで対応し、直したらレビュースレッドを resolve してください。'
        : 'public repo は main を PR 必須で保護しているためリポジトリ内スライスを置きません。' +
            'この全体一覧の当該セクションを確認して対応し、直したらレビュースレッドを resolve してください。',
    );
    all.push('```');
    all.push('');
    all.push(...tableLines(mine));
  }
}
all.push(...abandonedLines(abandoned));
all.push(
  ...footerLines([
    'private の対象リポジトリには**そのリポジトリの分だけ**を抜き出した ' +
      '`.ops-sync/review-inbox.md` も置いてある。public repo は main を PR 必須で保護するため、',
    '直接 push するスライスを置かず、この全体一覧だけに載せる。この全体一覧はここにしか無い。',
    '',
  ]),
);
writeIfChanged(outAll, all);
removeLegacy(dirname(outAll), LEGACY_ALL_BASENAME);

// ── リポジトリごとのスライス（指定された private consumer の .ops-sync/ に置く）─────────────
for (const repo of sliceRepos) {
  const mine = findings.filter((f) => f.repo === repo);
  // そのリポジトリ自身の取得失敗だけを載せる（他リポジトリの事情を持ち込まない）
  const myFailures = failures.filter((f) => f.repo === repo || f.repo.startsWith(`${repo}#`));
  const short = repo.split('/')[1];
  const lines = [...headerLines(`（\`${short}\`）`)];
  lines.push(...failureLines(myFailures));
  lines.push(`## 未対応 ${mine.length} 件`);
  lines.push('');
  if (mine.length === 0) {
    lines.push('このリポジトリに未 resolve のレビュー指摘はありません。');
    lines.push('');
  } else {
    lines.push(...tableLines(mine));
  }
  lines.push(...abandonedLines(abandoned.filter((a) => a.repo === repo)));
  lines.push(...footerLines([`これは \`${repo}\` の分だけを抜き出したもの。全リポジトリ分の一覧は別にある。`, '']));
  const sliceDir = join(clonesDir, repo, '.ops-sync');
  writeIfChanged(join(sliceDir, 'review-inbox.md'), lines);
  removeLegacy(sliceDir, LEGACY_SLICE_BASENAME);
}

console.log(
  `summary repos=${repos.length} slice_repos=${sliceRepos.length} failures=${failures.length} open_findings=${findings.length} ` +
    `merged_unresolved=${mergedCount} closed_excluded=${abandoned.reduce((n, a) => n + a.count, 0)} ` +
    `files_changed=${filesChanged} lookback_days=${lookbackDays} ratelimit_remaining=${rate?.remaining ?? '?'}`,
);

setOutput('open_findings', String(findings.length));
setOutput('merged_unresolved', String(mergedCount));
setOutput('failures', String(failures.length));
setOutput('files_changed', String(filesChanged));
// マージ済み PR に残っている指摘を抱えた repo 名。workflow がこれを使って run を失敗させ、
// 「一覧に積まれたが誰も拾っていない」状態を可視化する（→ 下記 setOutput の直前のコメント）。
// repo 名は件数と同じく公開してよい情報（指摘本文・パスは出さない）。
setOutput(
  'merged_unresolved_repos',
  [...new Set(findings.filter((f) => f.prMerged).map((f) => f.repo))].sort().join(' '),
);
