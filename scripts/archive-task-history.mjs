// タスク履歴の保守バッチ（consolidate + archive）。規約は shared/docs/task-history.md。
//
// エージェントは履歴を docs/AI_TASK_HISTORY.md へ直接追記せず、1エントリ＝1ファイルで
// docs/history-inbox/<YYYY-MM-DD>-<スラッグ>.md に置く（並行 PR が同じ行に触れずコンフリクトを
// 避けるため＝towncrier 型のフラグメント）。このバッチが:
//   1. docs/history-inbox/ の全フラグメントを docs/AI_TASK_HISTORY.md へ取り込み（新しい日付が上）、
//      取り込んだフラグメントファイルを削除する（consolidate）。
//   2. 取り込み後、本体に残すのは「エントリのある日付で数えて直近2作業日分」。超過した古い日付の
//      エントリを docs/history-archive/<YYYY>.md の先頭へ丸ごと移す（archive）。
// いずれもエントリ本文は書き直さない（体裁はそのまま・スライスの移動だけ）。
//
// この処理は完全に機械的なので、エージェントのセッションではなく
// .github/workflows/archive-task-history.yml（ai-ops 集中バッチ）から実行する。
//
// 使い方: node archive-task-history.mjs <repo root>
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';

const KEEP_WORKDAYS = 2;

const [, , repoRoot] = process.argv;
if (!repoRoot) {
  console.error('usage: node archive-task-history.mjs <repo root>');
  process.exit(2);
}

const docsDir = path.join(repoRoot, 'docs');
const historyPath = path.join(docsDir, 'AI_TASK_HISTORY.md');
const inboxDir = path.join(docsDir, 'history-inbox');

// `## ` 見出しでブロックに割る共通処理。各ブロックは元テキストのスライス（行を書き換えない）。
const headingRe = /^## .*$/gm;
const splitBlocks = (text) => {
  const headings = [...text.matchAll(headingRe)];
  const blocks = headings.map((m, i) => {
    const end = i + 1 < headings.length ? headings[i + 1].index : text.length;
    const date = /^## (\d{4}-\d{2}-\d{2})(?:\s|$)/.exec(m[0])?.[1] ?? null;
    return { date, text: text.slice(m.index, end) };
  });
  const preamble = headings.length ? text.slice(0, headings[0].index) : text;
  return { preamble, blocks };
};

// --- 1. 本体（AI_TASK_HISTORY.md）を preamble＋ブロックに分解 ---
let preamble = '';
let mainBlocks = [];
if (existsSync(historyPath)) {
  ({ preamble, blocks: mainBlocks } = splitBlocks(readFileSync(historyPath, 'utf8')));
}

// --- 2. inbox の各フラグメントを取り込む（有効エントリを含むファイルだけ削除対象にする） ---
const inboxBlocks = [];
const consumedFiles = [];
if (existsSync(inboxDir)) {
  // README.md は取り込まない: ディレクトリを常に git 追跡状態に保つプレースホルダ
  // （ai-ops が配布・維持）。これを消すと、全フラグメント統合後に inbox が空になり
  // fresh checkout で「書き込み先」ディレクトリごと消える。
  const files = readdirSync(inboxDir)
    .filter((f) => f.endsWith('.md') && f.toLowerCase() !== 'readme.md')
    .sort();
  for (const f of files) {
    const fp = path.join(inboxDir, f);
    const { blocks } = splitBlocks(readFileSync(fp, 'utf8'));
    const entries = blocks.filter((b) => b.date); // 日付付き `## ` 見出しだけを取り込む
    if (entries.length === 0) {
      console.warn(`skip ${path.join('docs/history-inbox', f)}: 日付付き '## YYYY-MM-DD' エントリが無い（削除しない）`);
      continue;
    }
    inboxBlocks.push(...entries);
    consumedFiles.push(fp);
  }
}

if (mainBlocks.length === 0 && inboxBlocks.length === 0) {
  console.log('no entries; nothing to do');
  process.exit(0);
}

// preamble が空（本体が未作成）で inbox から起こす場合は既定のヘッダを付ける。
if (!preamble.trim()) {
  preamble = '# AI Task History\n\n' +
    '運用規約（保持ルール・書き方・アーカイブ手順）は [`docs/task-history.md`](task-history.md) を参照。\n' +
    '古い履歴は [`docs/history-archive/<YYYY>.md`](history-archive/) を参照。\n\n---\n';
}

// --- 3. 取り込み結果を統合。日付付きは新しい順に安定ソート、日付無しは本体先頭に固定で残す ---
const allBlocks = [...inboxBlocks, ...mainBlocks];
const undated = allBlocks.filter((b) => !b.date); // 日付の付かない `## ` 見出し（対象外・常に本体に残す）
const dated = allBlocks.filter((b) => b.date);
dated.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)); // 新しい順（安定ソート）

const dates = [...new Set(dated.map((b) => b.date))]; // 既に降順・重複除去で最新順
const overRetention = dates.length > KEEP_WORKDAYS;

// inbox 取り込みも保持量超過も無ければ何もしない（空 PR を作らない）。
if (consumedFiles.length === 0 && !overRetention) {
  console.log(`within retention (${dates.length} workday(s)), no inbox fragments; nothing to do`);
  process.exit(0);
}

const keep = new Set(dates.slice(0, KEEP_WORKDAYS));
const keptDated = dated.filter((b) => keep.has(b.date));
const moved = dated.filter((b) => !keep.has(b.date));

// 連結時の境界だけ空行1つに正規化する（エントリ本文には触れない）。
const join = (parts) => parts.map((p) => p.replace(/\s+$/, '')).join('\n\n') + '\n';

// --- 4. 超過分を年ごとにアーカイブの先頭（preamble の直後・既存エントリの前）へ差し込む ---
const byYear = new Map();
for (const b of moved) {
  const year = b.date.slice(0, 4);
  if (!byYear.has(year)) byYear.set(year, []);
  byYear.get(year).push(b); // ソート済み＝新しい順を維持
}
for (const [year, entries] of byYear) {
  const archivePath = path.join(docsDir, 'history-archive', `${year}.md`);
  let head = `# 作業履歴アーカイブ ${year}\n\n` +
    '`docs/AI_TASK_HISTORY.md` から移されたエントリ（新しいエントリが上）。' +
    '規約: [`../task-history.md`](../task-history.md)。\n\n---\n';
  let tail = '';
  if (existsSync(archivePath)) {
    const cur = readFileSync(archivePath, 'utf8');
    const first = cur.match(headingRe);
    const cut = first ? cur.indexOf(first[0]) : cur.length;
    head = cur.slice(0, cut);
    tail = cur.slice(cut);
  }
  mkdirSync(path.dirname(archivePath), { recursive: true });
  writeFileSync(archivePath, join([head, ...entries.map((e) => e.text), tail].filter((s) => s.trim())));
  console.log(`archived ${entries.length} entr(ies) -> ${path.relative(repoRoot, archivePath)}`);
}

// --- 5. 本体を書き出し、取り込んだフラグメントを削除 ---
mkdirSync(docsDir, { recursive: true });
writeFileSync(historyPath, join([preamble, ...undated.map((b) => b.text), ...keptDated.map((b) => b.text)]));
for (const fp of consumedFiles) {
  rmSync(fp);
  console.log(`consumed -> removed ${path.relative(repoRoot, fp)}`);
}
console.log(
  `consolidated ${inboxBlocks.length} inbox entr(ies); ` +
  `kept ${undated.length + keptDated.length} entr(ies) across ${[...keep].join(', ') || '(none)'}; moved ${moved.length}`,
);
