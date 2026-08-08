// review-inbox.mjs の分類（マージ済み／open／クローズ未マージ）・持ち越し・**投稿者を問わず拾うこと**を
// 実駆動で確認する。旧名（`codex-` 接頭辞）の生成物の後始末もここで見る。
//
// 実行: リポジトリルートで `node --test`（新旧の Node で拾い方が変わらない呼び方）
//
// スクリプトは import 時に走り切る作りなので、`globalThis.fetch` を差し替えた薄いエントリから読み込み、
// GraphQL の応答を固定値で返す（ネットワーク・トークン不要）。

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'scripts', 'review-inbox.mjs');

const BOT = 'chatgpt-codex-connector';
const OWNER = '65edh5ih'; // Claude Code の `/code-review --comment` はオーナー本人の login で投稿される
const now = new Date().toISOString();

function thread({ resolved = false, url, author = BOT, body = '**![P1 Badge](x) 直してほしい**' } = {}) {
  return {
    isResolved: resolved,
    isOutdated: false,
    comments: {
      nodes: [{ author: author === null ? null : { login: author }, createdAt: now, url, path: 'a.js', body }],
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

function run({ recentPrs = PRS, previousAll = null, legacyAll = null, legacySlice = null, env = {} } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'ri-'));
  const sliceDir = path.join(dir, 'clones', 'o', 'r', '.ops-sync');
  const outAll = path.join(sliceDir, 'review-inbox-all.md');
  const legacyAllPath = path.join(sliceDir, 'codex-review-inbox-all.md');
  const legacySlicePath = path.join(sliceDir, 'codex-review-inbox.md');
  mkdirSync(sliceDir, { recursive: true });
  if (previousAll !== null) writeFileSync(outAll, previousAll);
  if (legacyAll !== null) writeFileSync(legacyAllPath, legacyAll);
  if (legacySlice !== null) writeFileSync(legacySlicePath, legacySlice);

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
      RI_TOKEN: 'x',
      RI_REPOS: 'o/r',
      RI_SLICE_REPOS: 'o/r',
      RI_CLONES: path.join(dir, 'clones'),
      RI_OUT_ALL: outAll,
      GITHUB_OUTPUT: path.join(dir, 'gh-output'),
      ...env,
    },
  });
  assert.equal(res.status, 0, res.stderr);
  return {
    stdout: res.stdout,
    all: readFileSync(outAll, 'utf8'),
    slice: readFileSync(path.join(sliceDir, 'review-inbox.md'), 'utf8'),
    legacyAllExists: existsSync(legacyAllPath),
    legacySliceExists: existsSync(legacySlicePath),
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

test('Codex 以外の投稿者（オーナー login＝Claude Code の経路）も在庫に載る', () => {
  const { all, outputs } = run({
    recentPrs: [
      pr(1, {
        state: 'MERGED',
        merged: true,
        threads: [thread({ url: 'https://x/#m1', author: OWNER, body: '### 二重に閉じている\n\n本文' })],
      }),
    ],
  });

  assert.equal(outputs.open_findings, '1');
  assert.equal(outputs.merged_unresolved, '1');
  // レビュアー列に投稿者が出る／優先度バッジが無いので `--`／見出しは最初の非空行から拾う
  assert.match(all, new RegExp(`\\| 🔴 \\| -- \\| \\[#1\\]\\([^)]*\\) \\| ${OWNER} \\|`));
  assert.match(all, /二重に閉じている/);
});

test('author が取れないスレッドも落とさない', () => {
  const { all, outputs } = run({
    recentPrs: [pr(2, { state: 'OPEN', merged: false, threads: [thread({ url: 'https://x/#o1', author: null })] })],
  });

  assert.equal(outputs.open_findings, '1');
  assert.match(all, /\(unknown\)/);
});

test('RI_REVIEWERS を指定したときだけ投稿者で絞る', () => {
  const recentPrs = [
    pr(1, {
      state: 'MERGED',
      merged: true,
      threads: [thread({ url: 'https://x/#m1', author: BOT }), thread({ url: 'https://x/#m2', author: OWNER })],
    }),
  ];

  assert.equal(run({ recentPrs }).outputs.open_findings, '2');
  assert.equal(run({ recentPrs, env: { RI_REVIEWERS: BOT } }).outputs.open_findings, '1');
});

test('旧名の生成物は消え、持ち越しは旧名からも読み戻される', () => {
  // 改名の初回実行を模す: 新パスは無く、旧名の全体一覧に #1 と #2 が載っている
  const res = run({
    recentPrs: [],
    legacyAll: '# 前回\n\nhttps://github.com/o/r/pull/1\nhttps://github.com/o/r/pull/2\n',
    legacySlice: '# 前回のスライス\n',
  });

  assert.equal(res.outputs.open_findings, '2'); // 持ち越しが旧名から効いている
  assert.equal(res.legacyAllExists, false);
  assert.equal(res.legacySliceExists, false);
});
