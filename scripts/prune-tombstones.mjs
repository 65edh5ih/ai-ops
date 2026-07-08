// sync-deletions.txt（manifest 導入前の unmanaged ファイルを consumer から撤去するトゥームストーン）の
// うち、役目を終えた行（＝全 consumer の main にもう対象ファイルが無い）を自動で削る保守バッチ。
// 判定は clone 済みの consumer チェックアウト（main）に対して行うので、削除がまだ sync PR の
// 途中にある間は行が残る（マージされて main から消えた後の実行で刈られる）。
//
// 使い方: node prune-tombstones.mjs <ai-ops root> <consumers checkout root>
//   consumers root の構造: <root>/<owner>/<repo>/（collect-outbox workflow の clone をそのまま使う）
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const [, , aiOpsRoot, consumersRoot] = process.argv;
if (!aiOpsRoot || !consumersRoot) {
  console.error('usage: node prune-tombstones.mjs <ai-ops root> <consumers root>');
  process.exit(2);
}

const listPath = path.join(aiOpsRoot, 'sync-deletions.txt');
if (!existsSync(listPath)) {
  console.log('no sync-deletions.txt');
  process.exit(0);
}

const consumers = readFileSync(path.join(aiOpsRoot, 'consumers.txt'), 'utf8')
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'));

// clone が欠けている consumer がいると「もう無い」と断定できないので、何も刈らない（安全側）
const missing = consumers.filter((c) => !existsSync(path.join(consumersRoot, c)));
if (missing.length) {
  console.log(`consumer checkout missing (${missing.join(', ')}); skip pruning`);
  process.exit(0);
}

const lines = readFileSync(listPath, 'utf8').split('\n');
const kept = [];
let pruned = 0;
for (const line of lines) {
  const entry = line.trim();
  if (!entry || entry.startsWith('#')) {
    kept.push(line);
    continue;
  }
  const stillExists = consumers.some((c) => existsSync(path.join(consumersRoot, c, entry)));
  if (stillExists) {
    kept.push(line);
  } else {
    pruned++;
    console.log(`pruned ${entry}`);
  }
}

if (pruned === 0) {
  console.log('no prunable tombstones');
  process.exit(0);
}
writeFileSync(listPath, kept.join('\n'));
console.log(`pruned ${pruned} tombstone(s)`);
