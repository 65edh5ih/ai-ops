// ai-ops の AGENTS_COMMON.md を、consumer の AGENTS.md のマーカー区間に反映する。
//   - マーカーがあれば区間を置換
//   - 無ければ末尾に追記（＝初回自動配線）
//   - 変更が無ければファイルを触らない（PR を無駄に作らないため）
// 使い方: node apply-common.mjs <AGENTS_COMMON.md path> <consumer AGENTS.md path>
import { readFileSync, writeFileSync } from 'node:fs';

const START = '<!-- AI-OPS:COMMON START — このブロックは ai-ops が自動同期します。手で編集しないこと -->';
const END = '<!-- AI-OPS:COMMON END -->';

const [, , commonPath, targetPath] = process.argv;
if (!commonPath || !targetPath) {
  console.error('usage: node apply-common.mjs <common.md> <target AGENTS.md>');
  process.exit(2);
}

const body = readFileSync(commonPath, 'utf8').trim();
const block = `${START}\n${body}\n${END}`;

let target = '';
try { target = readFileSync(targetPath, 'utf8'); } catch { target = ''; }

const s = target.indexOf(START);
const e = target.indexOf(END);

let out;
if (s !== -1 && e !== -1 && e > s) {
  out = target.slice(0, s) + block + target.slice(e + END.length);
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
