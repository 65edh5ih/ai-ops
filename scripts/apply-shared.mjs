// ai-ops の shared/ 配下の実ファイルを、consumer の同じ相対パスへ配布する。
//   - shared/<path> → <consumer>/<path>（ディレクトリ構造を維持してコピー）
//   - 中身が同じファイルは書かない（PR を無駄に作らないため）
// AGENTS.md のマーカー区間（apply-common.mjs）と違い、ファイルそのものを丸ごと同期する共通インフラ用。
// 使い方: node apply-shared.mjs <ai-ops/shared dir> <consumer checkout root>
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';

const [, , sharedRoot, targetRoot] = process.argv;
if (!sharedRoot || !targetRoot) {
  console.error('usage: node apply-shared.mjs <shared dir> <consumer root>');
  process.exit(2);
}

function walk(dir, base = dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, base));
    else out.push(path.relative(base, p));
  }
  return out;
}

if (!existsSync(sharedRoot)) {
  console.log(`no shared dir: ${sharedRoot}`);
  process.exit(0);
}

let changed = 0;
for (const rel of walk(sharedRoot)) {
  const src = readFileSync(path.join(sharedRoot, rel));
  const dst = path.join(targetRoot, rel);
  let cur = null;
  try { cur = readFileSync(dst); } catch {}
  if (cur && cur.equals(src)) continue;
  mkdirSync(path.dirname(dst), { recursive: true });
  writeFileSync(dst, src);
  console.log(`updated ${rel}`);
  changed++;
}
console.log(changed ? `applied ${changed} shared file(s)` : 'no shared changes');
