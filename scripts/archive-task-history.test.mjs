// archive-task-history.mjs の統合まわりの回帰テスト。
//
// 実行: リポジトリルートで `node --test`
//
// 対象は「フラグメントの見出しが2本あると空エントリが恒久履歴に入る」欠陥。フラグメントは
// **1エントリ＝1ファイル**が規約だが、生成した見出しの後ろに手で同じ見出しを書く事故が起きうる。
// そのとき1本目は「見出しだけ・本文なし」のブロックになり、そのまま取り込むと本体やアーカイブに
// 中身の無いレコードが残る（統合件数も水増しされる）。

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'scripts', 'archive-task-history.mjs');

function run(fragments, { history = '' } = {}) {
  const repo = mkdtempSync(path.join(tmpdir(), 'archive-history-'));
  const docs = path.join(repo, 'docs');
  const inbox = path.join(docs, 'history-inbox');
  mkdirSync(inbox, { recursive: true });
  writeFileSync(path.join(docs, 'AI_TASK_HISTORY.md'), history);
  for (const [name, text] of Object.entries(fragments)) writeFileSync(path.join(inbox, name), text);

  const res = spawnSync(process.execPath, [script, repo], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  return {
    stdout: res.stdout,
    stderr: res.stderr,
    history: readFileSync(path.join(docs, 'AI_TASK_HISTORY.md'), 'utf8'),
  };
}

test('見出しが重複したフラグメントでも空エントリを本体に入れない', () => {
  const dup = '## 2026-08-03 タイトル\n\n## 2026-08-03 タイトル\n\n本文がここにある。\n';
  const { history, stderr } = run({ '2026-08-03T120000Z-dup-aaaaaaaaaaaa.md': dup });

  // 見出しは1本だけ（＝空エントリが増えていない）
  assert.equal(history.match(/^## 2026-08-03 タイトル$/gm)?.length, 1, history);
  assert.match(history, /本文がここにある。/);
  assert.match(stderr, /skip-empty/);
});

test('正常なフラグメントはそのまま取り込む', () => {
  const ok = '## 2026-08-03 別のタイトル\n\n本文。\n';
  const { history, stderr } = run({ '2026-08-03T130000Z-ok-bbbbbbbbbbbb.md': ok });

  assert.equal(history.match(/^## 2026-08-03 別のタイトル$/gm)?.length, 1, history);
  assert.match(history, /本文。/);
  assert.doesNotMatch(stderr, /skip-empty/);
});

test('本文の無い見出しだけのフラグメントは消費せず残す', () => {
  const empty = '## 2026-08-03 見出しだけ\n';
  const { history, stderr } = run({ '2026-08-03T140000Z-empty-cccccccccccc.md': empty });

  assert.doesNotMatch(history, /見出しだけ/);
  assert.match(stderr, /skip-empty/);
  // 有効エントリが0件なのでフラグメントは削除対象にならない（= skip の警告が出る）
  assert.match(stderr, /日付付き '## YYYY-MM-DD' エントリが無い/);
});
