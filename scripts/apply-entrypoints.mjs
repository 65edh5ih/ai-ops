// consumer の AGENTS.md への「別名入口」を symlink で用意する（下り・配線）。
//   CLAUDE.md -> AGENTS.md   （Claude Code は CLAUDE.md を読む）
//   GEMINI.md -> AGENTS.md   （Gemini CLI に既定の GEMINI.md 探索で AGENTS.md を読ませる）
//   QWEN.md   -> AGENTS.md   （Qwen Code に既定の QWEN.md 探索で AGENTS.md を読ませる）
//
// これらは AGENTS.md（consumer ごとに内容が異なる／`shared/` の外）を指すため、
// shared/ 経由では配れない（apply-shared は symlink を実体化＝凍結してしまう）。
// よって各 consumer の checkout 内に、このスクリプトで直接 symlink を張る。
//
// - 既に AGENTS.md への symlink になっていれば何もしない（冪等）。
// - 別の宛先の symlink は張り直す。
// - 実体ファイル/ディレクトリが居座っている場合は上書きしない（consumer 固有の内容を壊さない）＝警告のみ。
// 使い方: node apply-entrypoints.mjs <consumer root>
import { existsSync, lstatSync, readlinkSync, symlinkSync, unlinkSync } from 'node:fs';
import path from 'node:path';

const [, , targetRoot] = process.argv;
if (!targetRoot) {
  console.error('usage: node apply-entrypoints.mjs <consumer root>');
  process.exit(2);
}

const TARGET = 'AGENTS.md';
const ALIASES = ['CLAUDE.md', 'GEMINI.md', 'QWEN.md'];

// AGENTS.md が無ければ壊れリンクになるだけなので何もしない
// （apply-common が先に AGENTS.md を用意している前提。未配線 consumer への保険）。
if (!existsSync(path.join(targetRoot, TARGET))) {
  console.log(`no ${TARGET} in consumer; skip entrypoint symlinks`);
  process.exit(0);
}

let changed = 0;
for (const alias of ALIASES) {
  const p = path.join(targetRoot, alias);
  let st = null;
  try { st = lstatSync(p); } catch {}
  if (st && st.isSymbolicLink()) {
    if (readlinkSync(p) === TARGET) continue; // 既に正しい symlink
    unlinkSync(p); // 別宛先 → 張り直す
  } else if (st) {
    console.warn(`[skip] ${alias} exists as a real file; not replacing with a symlink`);
    continue;
  }
  symlinkSync(TARGET, p); // 同ディレクトリ相対（AGENTS.md）
  console.log(`linked ${alias} -> ${TARGET}`);
  changed++;
}

console.log(changed ? `applied ${changed} entrypoint symlink(s)` : 'no entrypoint changes');
