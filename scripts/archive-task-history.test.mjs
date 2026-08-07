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

function run(fragments) {
  const repo = mkdtempSync(path.join(tmpdir(), 'archive-history-'));
  const docs = path.join(repo, 'docs');
  const inbox = path.join(docs, 'history-inbox');
  mkdirSync(inbox, { recursive: true });
  // 本体は空で先に作る（スクリプトが早期 exit する経路でも読み出せるように）。
  writeFileSync(path.join(docs, 'AI_TASK_HISTORY.md'), '');
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
  // 落とした見出しは警告に載る（フラグメントは削除されるので、載せないと復元できない）
  assert.match(stderr, /skip-empty .*## 2026-08-03 タイトル/);
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
  assert.match(stderr, /skip-empty .*## 2026-08-03 見出しだけ/);
  // 有効エントリが0件なのでフラグメントは削除対象にならない（= skip の警告が出る）。
  // 理由は「日付付き見出しが無い」ではなく「空だけ」——読んだ人が原因を取り違えないこと。
  assert.match(stderr, /skip .*本文の無い見出し 1 件だけで、取り込めるエントリが無い（削除しない）/);
  assert.doesNotMatch(stderr, /日付付き '## YYYY-MM-DD' エントリが無い/);
});
