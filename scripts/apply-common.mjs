// ops-sync の AGENTS_COMMON.md を、consumer の AGENTS.md のマーカー区間に反映する。
//   - マーカーがあれば区間を置換
//   - 無ければ末尾に追記（＝初回自動配線）
//   - 変更が無ければファイルを触らない（PR を無駄に作らないため）
// 使い方: node apply-common.mjs <AGENTS_COMMON.md path> <consumer AGENTS.md path>
import { readFileSync, writeFileSync } from 'node:fs';

const START = '<!-- OPS-SYNC:COMMON START — このブロックは ops-sync が自動同期します。手で編集しないこと -->';
const END = '<!-- OPS-SYNC:COMMON END -->';

// 旧マーカー（リポジトリ名が ai-ops だった頃）。consumer の AGENTS.md にはまだこちらが入っているので、
// 見つけたら新マーカーごと置き換える＝1回の同期で移行する。これが無いと新マーカーが見つからず
// 「末尾に追記」の経路へ落ち、全 consumer で共通ブロックが二重になる。
// 全 consumer が新マーカーへ移ったら、この2定数と findRegion の LEGACY 分岐は削除してよい。
const LEGACY_START = '<!-- AI-OPS:COMMON START — このブロックは ai-ops が自動同期します。手で編集しないこと -->';
const LEGACY_END = '<!-- AI-OPS:COMMON END -->';

const [, , commonPath, targetPath] = process.argv;
if (!commonPath || !targetPath) {
  console.error('usage: node apply-common.mjs <common.md> <target AGENTS.md>');
  process.exit(2);
}

const body = readFileSync(commonPath, 'utf8').trim();
const block = `${START}\n${body}\n${END}`;

let target = '';
try { target = readFileSync(targetPath, 'utf8'); } catch { target = ''; }

// 新マーカーを優先し、無ければ旧マーカーの区間を拾う（移行時に1回だけ効く）。
function findRegion(text) {
  for (const [s, e] of [[START, END], [LEGACY_START, LEGACY_END]]) {
    const i = text.indexOf(s);
    const j = text.indexOf(e);
    if (i !== -1 && j !== -1 && j > i) return { from: i, to: j + e.length };
  }
  return null;
}

// マーカーの状態を**区間を選ぶ前に**全数検査する。壊れた状態のまま追記フォールバックに落ちる／
// 健全な側の区間だけ差し替えると、壊れたマーカーと古い本文が残ったまま共通ブロックがもう1つ増え、
// 全エージェントが読む AGENTS.md に同じ規約が二重に載る。黙って直せないので失敗させる。
// 健全と認めるのは「新旧どちらか一方の組が start→end の順にちょうど1組」か「どちらも皆無」だけ。
// （移行中は旧の組だけ、移行後は新の組だけ。新旧が同時に揃っている状態も規約の二重掲載なので弾く。）
function markerProblems(text) {
  const count = (needle) => text.split(needle).length - 1;
  const problems = [];
  const sets = [
    ['OPS-SYNC:COMMON', START, END],
    ['AI-OPS:COMMON (legacy)', LEGACY_START, LEGACY_END],
  ];
  let complete = 0;
  for (const [label, s, e] of sets) {
    const ns = count(s);
    const ne = count(e);
    if (ns === 0 && ne === 0) continue;
    if (ns > 1 || ne > 1) {
      problems.push(`${label}: duplicated markers (start x${ns}, end x${ne})`);
    } else if (ns !== 1 || ne !== 1) {
      problems.push(`${label}: unpaired marker (start x${ns}, end x${ne})`);
    } else if (text.indexOf(e) < text.indexOf(s)) {
      problems.push(`${label}: end marker appears before start marker`);
    } else {
      complete += 1;
    }
  }
  if (complete > 1) {
    problems.push('both the current and legacy marker blocks are present (rules would be duplicated)');
  }
  return problems;
}

const problems = markerProblems(target);
if (problems.length > 0) {
  console.error(
    `error: ${targetPath} has a malformed OPS-SYNC:COMMON marker state:\n` +
      problems.map((p) => `  - ${p}`).join('\n') +
      '\nLeave exactly one start/end pair (or remove them all for initial wiring), then re-run.',
  );
  process.exit(1);
}

const region = findRegion(target);

let out;
if (region) {
  out = target.slice(0, region.from) + block + target.slice(region.to);
} else {
  const sep = target && !target.endsWith('\n') ? '\n' : '';
  out = `${target}${sep}\n${block}\n`;
}

if (out !== target) {
  writeFileSync(targetPath, out);
  console.log(`updated ${targetPath}`);
} else {
  console.log(`no change ${targetPath}`);
}
