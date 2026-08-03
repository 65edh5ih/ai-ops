// codex-review-inbox.mjs の分類（マージ済み／open／クローズ未マージ）と持ち越しの扱いを実駆動で確認する。
//
// 実行: リポジトリルートで `node --test`（新旧の Node で拾い方が変わらない呼び方）
//
// スクリプトは import 時に走り切る作りなので、`globalThis.fetch` を差し替えた薄いエントリから読み込み、
// GraphQL の応答を固定値で返す（ネットワーク・トークン不要）。

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'scripts', 'codex-review-inbox.mjs');

const BOT = 'chatgpt-codex-connector';
const now = new Date().toISOString();

function thread({ resolved = false, url } = {}) {
  return {
    isResolved: resolved,
    isOutdated: false,
    comments: {
      nodes: [{ author: { login: BOT }, createdAt: now, url, path: 'a.js', body: '**![P1 Badge](x) 直してほしい**' }],
    },
  };
}

function pr(number, { state, merged, threads }) {
  return {
    number,
    url: `https://github.com/o/r/pull/${number}`,
    title: `pr ${number}`,
    state,
    merged,
    updatedAt: now,
    reviewThreads: { pageInfo: { hasNextPage: false }, nodes: threads },
  };
}

// 直近スキャンで返す PR 群
const PRS = [
  pr(1, { state: 'MERGED', merged: true, threads: [thread({ url: 'https://x/#m1' })] }),
  pr(2, { state: 'OPEN', merged: false, threads: [thread({ url: 'https://x/#o1' })] }),
  pr(3, {
    state: 'CLOSED',
    merged: false,
    threads: [thread({ url: 'https://x/#c1' }), thread({ url: 'https://x/#c2' })],
  }),
  pr(4, { state: 'CLOSED', merged: false, threads: [thread({ resolved: true, url: 'https://x/#c3' })] }),
];

// 持ち越しでだけ届く（直近スキャンには出さない）クローズ済み PR
const CARRIED_ONLY = pr(9, { state: 'CLOSED', merged: false, threads: [thread({ url: 'https://x/#c9' })] });

function run({ recentPrs = PRS, previousAll = null } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'cri-'));
  const outAll = path.join(dir, 'clones', 'o', 'r', '.ops-sync', 'codex-review-inbox-all.md');
  if (previousAll !== null) {
    mkdirSync(path.dirname(outAll), { recursive: true });
    writeFileSync(outAll, previousAll);
  }

  const entry = path.join(dir, 'entry.mjs');
  writeFileSync(
    entry,
    `const PRS = ${JSON.stringify(recentPrs)};\n` +
      // 名指しの再確認（持ち越し）には、直近スキャンに出さない PR にも答える必要がある
      `const KNOWN = ${JSON.stringify([...PRS, CARRIED_ONLY])};\n` +
      `const byNumber = new Map(KNOWN.map((p) => [p.number, p]));\n` +
      `globalThis.fetch = async (_url, init) => {\n` +
      `  const { variables } = JSON.parse(init.body);\n` +
      `  const data = variables.number === undefined\n` +
      `    ? { repository: { pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: PRS } } }\n` +
      `    : { repository: { pullRequest: byNumber.get(variables.number) ?? null } };\n` +
      `  return { ok: true, json: async () => ({ data }) };\n` +
      `};\n` +
      `await import(${JSON.stringify(script)});\n`,
  );

  const res = spawnSync(process.execPath, [entry], {
    encoding: 'utf8',
    env: {
      ...process.env,
      CRI_TOKEN: 'x',
      CRI_REPOS: 'o/r',
      CRI_SLICE_REPOS: 'o/r',
      CRI_CLONES: path.join(dir, 'clones'),
      CRI_OUT_ALL: outAll,
      GITHUB_OUTPUT: path.join(dir, 'gh-output'),
    },
  });
  assert.equal(res.status, 0, res.stderr);
  return {
    stdout: res.stdout,
    all: readFileSync(outAll, 'utf8'),
    slice: readFileSync(path.join(dir, 'clones', 'o', 'r', '.ops-sync', 'codex-review-inbox.md'), 'utf8'),
    outputs: Object.fromEntries(
      readFileSync(path.join(dir, 'gh-output'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => l.split('=')),
    ),
  };
}

test('クローズ済み（未マージ）PR は在庫に載らず、注記にだけ出る', () => {
  const { all, slice, outputs, stdout } = run();

  // 在庫に載るのはマージ済み（🔴）と open（🟡）だけ
  assert.match(all, /## 未対応 2 件/);
  // 表の行は指摘コメントの URL で張るので、PR は `[#N]` で見る
  assert.match(all, /\| 🔴 \|.*\[#1\]/);
  assert.match(all, /\| 🟡 \|.*\[#2\]/);
  assert.doesNotMatch(all, /\| 🟡 \|.*\[#3\]/);
  assert.equal(outputs.open_findings, '2');
  assert.equal(outputs.merged_unresolved, '1');

  // クローズ分は件数だけ注記に出る（#3 の未 resolve 2件。resolve 済みだけの #4 は出ない）
  assert.match(all, /## ⚪ 対象外: クローズ済み（未マージ）PR/);
  assert.match(all, /未 resolve の指摘が \*\*2 件\*\*残っている/);
  assert.match(all, /\[#3\]\(https:\/\/github\.com\/o\/r\/pull\/3\) — 2件/);
  assert.doesNotMatch(all, /#4\]/);
  assert.match(slice, /## ⚪ 対象外: クローズ済み（未マージ）PR/);
  assert.match(stdout, /closed_excluded=2/);
});

test('クローズ済み PR は持ち越しで復活しない（注記は窓から外れれば消える）', () => {
  // 前回の一覧に #9（クローズ済み・直近スキャンには出ない）が載っていた状態から走らせる
  const { all, outputs } = run({ previousAll: '# 前回\n\nhttps://github.com/o/r/pull/9\n' });

  assert.doesNotMatch(all, /pull\/9/); // 表にも注記にも出ない
  assert.equal(outputs.open_findings, '2');
});

test('open / マージ済みは持ち越しで復活する（resolve されるまで消えない）', () => {
  // 直近スキャンが空でも、前回載っていた #1（マージ済み）と #2（open）は名指しで再確認される
  const { all, outputs } = run({
    recentPrs: [],
    previousAll: '# 前回\n\nhttps://github.com/o/r/pull/1\nhttps://github.com/o/r/pull/2\n',
  });

  assert.equal(outputs.open_findings, '2');
  assert.match(all, /\| 🔴 \|.*\[#1\]/);
  assert.match(all, /\| 🟡 \|.*\[#2\]/);
});
