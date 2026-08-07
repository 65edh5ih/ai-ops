// apply-common.mjs のマーカー検査まわりの回帰テスト。
//
// 実行: リポジトリルートで `node --test`
//
// 対象は「旧マーカーの検出が素の部分文字列だった」欠陥。`AI-OPS:COMMON` を数えるだけだと、
// 「旧マーカーは使うな」と本文で言及しただけの AGENTS.md まで壊れた状態と誤判定し、
// 同期全体（＝全 consumer への配布）を止めてしまう。判定はコメント構文まで一致させる。

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'scripts', 'apply-common.mjs');

const START =
  '<!-- OPS-SYNC:COMMON START — このブロックは ops-sync が自動同期します。手で編集しないこと -->';
const END = '<!-- OPS-SYNC:COMMON END -->';
const LEGACY_START =
  '<!-- AI-OPS:COMMON START — このブロックは ai-ops が自動同期します。手で編集しないこと -->';
const LEGACY_END = '<!-- AI-OPS:COMMON END -->';

function run(targetText, commonText = '共通ルール本文。\n') {
  const dir = mkdtempSync(path.join(tmpdir(), 'apply-common-'));
  const commonPath = path.join(dir, 'AGENTS_COMMON.md');
  const targetPath = path.join(dir, 'AGENTS.md');
  writeFileSync(commonPath, commonText);
  writeFileSync(targetPath, targetText);

  const res = spawnSync(process.execPath, [script, commonPath, targetPath], { encoding: 'utf8' });
  return { status: res.status, stderr: res.stderr, target: readFileSync(targetPath, 'utf8') };
}

test('実物の旧マーカーが残っていたら失敗させる', () => {
  const { status, stderr } = run(`# AGENTS.md\n\n${LEGACY_START}\n古い本文。\n${LEGACY_END}\n`);

  assert.equal(status, 1, stderr);
  assert.match(stderr, /AI-OPS:COMMON: legacy markers are no longer migrated/);
});

test('本文で旧マーカー名に言及しただけなら通す', () => {
  const target = `# AGENTS.md\n\n旧マーカー \`AI-OPS:COMMON\` はもう使わないこと。\n\n${START}\n古い本文。\n${END}\n`;
  const { status, stderr, target: out } = run(target);

  assert.equal(status, 0, stderr);
  assert.match(out, /共通ルール本文。/);
  assert.doesNotMatch(out, /古い本文。/);
  // 言及自体は残す（配布は本文を触らない）
  assert.match(out, /旧マーカー `AI-OPS:COMMON` はもう使わないこと。/);
});

test('現行マーカーが皆無なら末尾に追記する（初回配線）', () => {
  const { status, stderr, target: out } = run('# AGENTS.md\n\n固有パート。\n');

  assert.equal(status, 0, stderr);
  assert.match(out, /固有パート。/);
  assert.equal(out.split(START).length - 1, 1, out);
  assert.equal(out.split(END).length - 1, 1, out);
});

test('現行マーカーが重複していたら失敗させる', () => {
  const { status, stderr } = run(`${START}\nA\n${END}\n${START}\nB\n${END}\n`);

  assert.equal(status, 1, stderr);
  assert.match(stderr, /duplicated markers/);
});
