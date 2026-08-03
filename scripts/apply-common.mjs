// ops-sync の AGENTS_COMMON.md を、consumer の AGENTS.md のマーカー区間に反映する。
//   - マーカーがあれば区間を置換
//   - 無ければ末尾に追記（＝初回自動配線）
//   - 変更が無ければファイルを触らない（PR を無駄に作らないため）
// 使い方: node apply-common.mjs <AGENTS_COMMON.md path> <consumer AGENTS.md path>
import { readFileSync, writeFileSync } from 'node:fs';

const START = '<!-- OPS-SYNC:COMMON START — このブロックは ops-sync が自動同期します。手で編集しないこと -->';
const END = '<!-- OPS-SYNC:COMMON END -->';

// 旧マーカー（リポジトリ名が ai-ops だった頃）。移行は全 consumer で完了したので**もう変換しない**が、
// 検出だけ残す: 旧マーカーだけの AGENTS.md を黙って処理すると、新マーカーが見つからず追記
// フォールバックへ落ちて共通ブロックが二重になる。壊すより失敗させて人に掃除させる。
const LEGACY_MARKER = 'AI-OPS:COMMON';

const [, , commonPath, targetPath] = process.argv;
if (!commonPath || !targetPath) {
  console.error('usage: node apply-common.mjs <common.md> <target AGENTS.md>');
  process.exit(2);
}

const body = readFileSync(commonPath, 'utf8').trim();
const block = `${START}\n${body}\n${END}`;

let target = '';
try { target = readFileSync(targetPath, 'utf8'); } catch { target = ''; }

function findRegion(text) {
  const i = text.indexOf(START);
  const j = text.indexOf(END);
  if (i !== -1 && j !== -1 && j > i) return { from: i, to: j + END.length };
  return null;
}

// マーカーの状態を**区間を選ぶ前に**全数検査する。壊れた状態のまま追記フォールバックに落ちる／
// 健全な側の区間だけ差し替えると、壊れたマーカーと古い本文が残ったまま共通ブロックがもう1つ増え、
// 全エージェントが読む AGENTS.md に同じ規約が二重に載る。黙って直せないので失敗させる。
// 健全と認めるのは「現行の組が start→end の順にちょうど1組」か「皆無」（＝初回配線）だけ。
function markerProblems(text) {
  const count = (needle) => text.split(needle).length - 1;
  const problems = [];
  const ns = count(START);
  const ne = count(END);
  if (ns > 1 || ne > 1) {
    problems.push(`OPS-SYNC:COMMON: duplicated markers (start x${ns}, end x${ne})`);
  } else if (ns !== ne) {
    problems.push(`OPS-SYNC:COMMON: unpaired marker (start x${ns}, end x${ne})`);
  } else if (ns === 1 && text.indexOf(END) < text.indexOf(START)) {
    problems.push('OPS-SYNC:COMMON: end marker appears before start marker');
  }
  // 旧マーカーはもう変換しない。残っていたら追記フォールバックで二重掲載になるので弾く。
  if (count(LEGACY_MARKER) > 0) {
    problems.push(
      `${LEGACY_MARKER}: legacy markers are no longer migrated; remove them (keep only the OPS-SYNC:COMMON pair)`,
    );
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
