// consumer → ai-ops の「上り」経路。
// 各 consumer の .ai-ops/outbox/*.md（共通ブロックの編集後・全文）を1件拾い、
// ai-ops の AGENTS_COMMON.md に反映する。拾った提案ファイルは consumer 側で削除する
// （cleanup PR は workflow が別途立てる）。
//
// 1 回の実行で 1 件だけ処理する（＝編集を直列化し、複数提案が暗黙に潰し合うのを防ぐ）。
// 残りは次回 cron で、更新後の AGENTS_COMMON.md を土台に処理される。
//
// 使い方: node collect-outbox.mjs <AGENTS_COMMON.md path> <consumers checkout root>
//   consumers root の構造: <root>/<owner>/<repo>/.ai-ops/outbox/*.md
import { readFileSync, writeFileSync, readdirSync, existsSync, rmSync, appendFileSync } from 'node:fs';
import path from 'node:path';

const START = '<!-- AI-OPS:COMMON START';
const END = '<!-- AI-OPS:COMMON END -->';

const [, , commonPath, consumersRoot] = process.argv;
if (!commonPath || !consumersRoot) {
  console.error('usage: node collect-outbox.mjs <AGENTS_COMMON.md> <consumers root>');
  process.exit(2);
}

function dirs(p) {
  if (!existsSync(p)) return [];
  return readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
}

// 全 consumer の outbox 提案を集める
const proposals = [];
for (const owner of dirs(consumersRoot)) {
  for (const repo of dirs(path.join(consumersRoot, owner))) {
    const outbox = path.join(consumersRoot, owner, repo, '.ai-ops', 'outbox');
    if (!existsSync(outbox)) continue;
    for (const name of readdirSync(outbox).filter((n) => n.endsWith('.md'))) {
      proposals.push({ repo: `${owner}/${repo}`, file: path.join(outbox, name), name });
    }
  }
}

if (proposals.length === 0) {
  console.log('no proposals');
  process.exit(0);
}

// ファイル名（先頭に ISO 時刻を付ける規約）で最古を1件選ぶ
proposals.sort((a, b) => a.name.localeCompare(b.name));
const chosen = proposals[0];

// 提案本文＝共通ブロックの編集後・全文。マーカー行が紛れていても落とす。
const body = readFileSync(chosen.file, 'utf8')
  .split('\n')
  .filter((l) => !l.startsWith(START) && l.trim() !== END)
  .join('\n')
  .trim();

if (!body) {
  console.error(`empty proposal: ${chosen.repo}/${chosen.name}`);
  process.exit(1);
}

writeFileSync(commonPath, body + '\n');
rmSync(chosen.file); // consumer checkout 側で削除をステージ（cleanup PR の元になる）

const out = process.env.GITHUB_OUTPUT;
if (out) {
  appendFileSync(out, `found=true\n`);
  appendFileSync(out, `consumer=${chosen.repo}\n`);
  appendFileSync(out, `consumer_dir=${path.join(consumersRoot, chosen.repo)}\n`);
  appendFileSync(out, `proposal=${chosen.name}\n`);
}
console.log(`applied proposal ${chosen.name} from ${chosen.repo}`);
