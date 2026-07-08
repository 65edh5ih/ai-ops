// タスク履歴の保持量超過分を docs/history-archive/<YYYY>.md へ移す（保守バッチ）。
// 規約は shared/docs/task-history.md: docs/AI_TASK_HISTORY.md に残すのは
// 「エントリのある日付で数えて直近2作業日分」。3日分以上になったら古い日付の
// エントリを丸ごとアーカイブの先頭へ移す（体裁はそのまま・書き直さない）。
//
// この移動は完全に機械的なので、エージェントのセッションではなく
// .github/workflows/archive-task-history.yml（ai-ops 集中バッチ）から実行する。
//
// 使い方: node archive-task-history.mjs <repo root>
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const KEEP_WORKDAYS = 2;

const [, , repoRoot] = process.argv;
if (!repoRoot) {
  console.error('usage: node archive-task-history.mjs <repo root>');
  process.exit(2);
}

const historyPath = path.join(repoRoot, 'docs', 'AI_TASK_HISTORY.md');
if (!existsSync(historyPath)) {
  console.log(`no history file (${historyPath}); nothing to do`);
  process.exit(0);
}

const text = readFileSync(historyPath, 'utf8');

// `## ` 見出しでブロックに割る。先頭〜最初の見出しが preamble。
// 各ブロックは元テキストのスライス（行の書き換えをしない）。
const headingRe = /^## .*$/gm;
const headings = [...text.matchAll(headingRe)];
if (headings.length === 0) {
  console.log('no entries; nothing to do');
  process.exit(0);
}
const preamble = text.slice(0, headings[0].index);
const blocks = headings.map((m, i) => {
  const end = i + 1 < headings.length ? headings[i + 1].index : text.length;
  const date = /^## (\d{4}-\d{2}-\d{2})(?:\s|$)/.exec(m[0])?.[1] ?? null;
  return { date, text: text.slice(m.index, end) };
});

// 日付の付かない見出しは対象外（本体に残す）。日付は文字列比較で新しい順。
const dates = [...new Set(blocks.map((b) => b.date).filter(Boolean))].sort().reverse();
if (dates.length <= KEEP_WORKDAYS) {
  console.log(`within retention (${dates.length} workday(s)); nothing to do`);
  process.exit(0);
}
const keep = new Set(dates.slice(0, KEEP_WORKDAYS));
const kept = blocks.filter((b) => !b.date || keep.has(b.date));
const moved = blocks.filter((b) => b.date && !keep.has(b.date));

// 連結時の境界だけ空行1つに正規化する（エントリ本文には触れない）。
const join = (parts) => parts.map((p) => p.replace(/\s+$/, '')).join('\n\n') + '\n';

// 移動分を年ごとにアーカイブの先頭（preamble の直後・既存エントリの前）へ差し込む。
const byYear = new Map();
for (const b of moved) {
  const year = b.date.slice(0, 4);
  if (!byYear.has(year)) byYear.set(year, []);
  byYear.get(year).push(b); // 元ファイル順＝新しい順を維持
}
for (const [year, entries] of byYear) {
  const archivePath = path.join(repoRoot, 'docs', 'history-archive', `${year}.md`);
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

writeFileSync(historyPath, join([preamble, ...kept.map((b) => b.text)]));
console.log(`kept ${kept.length} entr(ies) across ${[...keep].join(', ')}; moved ${moved.length}`);
