import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'shared', 'scripts', 'new-task-history.mjs');

function run(cwd, args) {
  return spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' });
}

test('creates distinct, well-formed history fragments without overwriting', () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'new-task-history-'));
  const first = run(cwd, ['Codex public slices/work', 'Codex public slices の衝突防止']);
  const second = run(cwd, ['Codex public slices/work', '同じ秒の別セッション']);

  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);

  const firstPath = first.stdout.trim();
  const secondPath = second.stdout.trim();
  const pattern = /^docs\/history-inbox\/(\d{4}-\d{2}-\d{2})T\d{6}Z-codex-public-slices-work-[0-9a-f]{12}\.md$/;
  const firstMatch = firstPath.match(pattern);

  assert.ok(firstMatch, firstPath);
  assert.match(secondPath, pattern);
  assert.notEqual(firstPath, secondPath);
  assert.equal(
    readFileSync(path.join(cwd, firstPath), 'utf8'),
    `## ${firstMatch[1]} Codex public slices の衝突防止\n\n`,
  );
  assert.equal(statSync(path.join(cwd, firstPath)).mode & 0o777, 0o644);
});

test('rejects missing, non-ASCII, and multiline inputs', () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'new-task-history-invalid-'));

  assert.equal(run(cwd, []).status, 2);
  assert.equal(run(cwd, ['履歴', 'タイトル']).status, 2);
  assert.equal(run(cwd, ['valid', 'line one\nline two']).status, 2);
});
