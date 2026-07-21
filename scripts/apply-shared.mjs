// ai-ops の配布物を consumer のチェックアウトへミラーする（下り・ファイル配布）。
//   - shared/<path>              → <consumer>/<path>（ディレクトリ構造を維持してコピー）
//   - tasks/<owner>/<repo>/<f>   → <consumer>/.ai-ops/tasks/<f>（その consumer 宛のタスクのみ）
//
// skill ミラーの自動導出: 正本 shared/.claude/skills/** は、各エージェント向けの
// .codex/.openhands/.gemini/.agents の skills/ にも同内容で配布する（配布時に導出）。
// 以前は ai-ops 側に symlink を1エージェントぶんずつ手で置いていたが、完全に機械的な複製で
// 張り忘れのドリフト源だったため、リポジトリには正本だけを置く方式に変えた。
// 新エージェント対応は SKILL_MIRROR_ROOTS への追加1行。
//
// 配布したファイル一覧を consumer の .ai-ops/sync-manifest.txt に記録し、
// **前回 manifest にあって今回の配布物に無いパスは削除する**（shared/ での撤去・改名や
// タスク消化を consumer へ伝播させる。旧実装は追加・更新しかできず、消したファイルが
// consumer に残留するドリフトがあった）。
// さらに ai-ops の sync-deletions.txt に列挙されたパスも削除する（manifest 導入前から
// consumer に置かれている unmanaged ファイルの撤去用）。
//
// 中身が同じファイルは書かない（PR を無駄に作らないため）。
// 使い方: node apply-shared.mjs <ai-ops root> <consumer checkout root> <owner/repo>
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync, rmSync, statSync, chmodSync } from 'node:fs';
import path from 'node:path';

const MANIFEST = '.ai-ops/sync-manifest.txt';

// skill の正本ディレクトリと、そこから導出する各エージェントのミラー先
const SKILL_CANON = '.claude/skills/';
const SKILL_MIRROR_ROOTS = ['.codex', '.openhands', '.gemini', '.agents'];

const [, , aiOpsRoot, targetRoot, consumerSlug] = process.argv;
if (!aiOpsRoot || !targetRoot || !consumerSlug) {
  console.error('usage: node apply-shared.mjs <ai-ops root> <consumer root> <owner/repo>');
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

// 安全弁: 書き込み・削除は consumer ルート相対のパスのみ。範囲外・.git・AGENTS.md を拒否。
function safeRel(rel) {
  const norm = path.posix.normalize(rel.split(path.sep).join('/'));
  if (!norm || norm === '.' || path.posix.isAbsolute(norm)) return false;
  if (norm.startsWith('..')) return false;
  if (norm === '.git' || norm.startsWith('.git/')) return false;
  if (norm === 'AGENTS.md') return false; // マーカー区間は apply-common の管轄。丸ごと消させない
  return true;
}

function readList(p) {
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

// 配布対象を組み立てる: consumer 相対パス → ソース絶対パス
const desired = new Map();
const sharedRoot = path.join(aiOpsRoot, 'shared');
if (existsSync(sharedRoot)) {
  for (const rel of walk(sharedRoot)) desired.set(rel.split(path.sep).join('/'), path.join(sharedRoot, rel));
}
// skill ミラーを正本から導出（shared/ に明示的に置かれた同パスのファイルがあればそちらを優先）
for (const [rel, src] of [...desired]) {
  if (!rel.startsWith(SKILL_CANON)) continue;
  for (const root of SKILL_MIRROR_ROOTS) {
    const mirror = path.posix.join(root, 'skills', rel.slice(SKILL_CANON.length));
    if (!desired.has(mirror)) desired.set(mirror, src);
  }
}
const tasksRoot = path.join(aiOpsRoot, 'tasks', consumerSlug);
if (existsSync(tasksRoot)) {
  for (const rel of walk(tasksRoot)) {
    desired.set(path.posix.join('.ai-ops/tasks', rel.split(path.sep).join('/')), path.join(tasksRoot, rel));
  }
}

let changed = 0;

// 追加・更新
for (const [rel, src] of desired) {
  if (!safeRel(rel)) {
    console.error(`[skip] unsafe path: ${rel}`);
    continue;
  }
  const dst = path.join(targetRoot, rel);
  const buf = readFileSync(src);
  const mode = statSync(src).mode & 0o777; // 実行ビット等を正本から保持（配布 hook/スクリプトが実行可能であるように）
  let cur = null;
  let curMode = null;
  try { cur = readFileSync(dst); curMode = statSync(dst).mode & 0o777; } catch {}
  if (cur && cur.equals(buf) && curMode === mode) continue;
  mkdirSync(path.dirname(dst), { recursive: true });
  writeFileSync(dst, buf);
  chmodSync(dst, mode);
  console.log(`updated ${rel}`);
  changed++;
}

// 削除: (前回 manifest ∪ sync-deletions.txt) のうち、今回の配布物に無い既存ファイル
const oldManifest = readList(path.join(targetRoot, MANIFEST));
const tombstones = readList(path.join(aiOpsRoot, 'sync-deletions.txt'));
for (const rel of new Set([...oldManifest, ...tombstones])) {
  const norm = rel.split(path.sep).join('/');
  if (desired.has(norm) || !safeRel(norm)) continue;
  const dst = path.join(targetRoot, norm);
  if (existsSync(dst)) {
    rmSync(dst);
    console.log(`deleted ${norm}`);
    changed++;
  }
}

// manifest を書き直す
const manifestBody = [...desired.keys()].filter(safeRel).sort().join('\n') + '\n';
const manifestPath = path.join(targetRoot, MANIFEST);
let curManifest = null;
try { curManifest = readFileSync(manifestPath, 'utf8'); } catch {}
if (curManifest !== manifestBody) {
  mkdirSync(path.dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, manifestBody);
  console.log(`updated ${MANIFEST}`);
  changed++;
}

console.log(changed ? `applied ${changed} change(s)` : 'no shared changes');
