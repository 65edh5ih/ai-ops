// consumer → ai-ops の「上り」経路。
// 各 consumer の .ai-ops/outbox/*.md を1件拾い、種別に応じて処理する:
//   - common-block-edit : AGENTS_COMMON.md を全文置換
//   - shared-file       : shared/<対象パス> にファイルを配置
// 種別が不明な提案（frontmatter 未記載かつマーカー不在）は安全のため取り込まずスキップ。
//
// 1 回の実行で 1 件だけ処理する（編集を直列化し複数提案が潰し合うのを防ぐ）。
//
// 使い方: node collect-outbox.mjs <AGENTS_COMMON.md path> <consumers checkout root> [<ai-ops root>]
//   consumers root の構造: <root>/<owner>/<repo>/.ai-ops/outbox/*.md
import {
  readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, rmSync, appendFileSync,
} from 'node:fs';
import path from 'node:path';

const COMMON_START = '<!-- AI-OPS:COMMON START';
const COMMON_END   = '<!-- AI-OPS:COMMON END -->';

// 共通ブロック全文に必須のマーカーが両方あるか
function hasCommonMarkers(text) {
  return text.includes(COMMON_START) && text.includes(COMMON_END);
}

// 先頭の YAML frontmatter を解析して { 種別, 対象パス } を返す
function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!m) return {};
  const meta = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([^:]+):\s*(.*)/);
    if (kv) meta[kv[1].trim()] = kv[2].trim();
  }
  return meta;
}

// frontmatter を除いた本文を返す
function stripFrontmatter(text) {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim();
}

// 削除率チェック: 既存行数に対して削除が DELETE_RATIO_LIMIT を超えたら中断
const DELETE_RATIO_LIMIT = 0.5;
function checkDeletionRatio(oldText, newText, proposalId) {
  const oldLines = oldText.split('\n').length;
  const newLines = newText.split('\n').length;
  const deleted = Math.max(0, oldLines - newLines);
  if (oldLines > 10 && deleted / oldLines > DELETE_RATIO_LIMIT) {
    console.error(
      `[guard] ${proposalId}: 削除率 ${Math.round(deleted / oldLines * 100)}% が上限 ${DELETE_RATIO_LIMIT * 100}% を超えています。` +
      `取り込みを中断します（意図的な大幅削減であれば手動で適用してください）。`,
    );
    process.exit(1);
  }
}

const [, , commonPath, consumersRoot, aiOpsRoot = '.'] = process.argv;
if (!commonPath || !consumersRoot) {
  console.error('usage: node collect-outbox.mjs <AGENTS_COMMON.md> <consumers root> [<ai-ops root>]');
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
const proposalId = `${chosen.repo}/${chosen.name}`;

const raw = readFileSync(chosen.file, 'utf8');
const meta = parseFrontmatter(raw);
const 種別 = meta['種別'] || '';

// ── 種別判定 ──────────────────────────────────────────────────────────────────
// 明示 frontmatter があればそれを優先。
// frontmatter がなければマーカー存在をフォールバック判定（後方互換）。
let resolvedType;
if (種別 === 'common-block-edit') {
  resolvedType = 'common-block-edit';
} else if (種別 === 'shared-file') {
  resolvedType = 'shared-file';
} else if (!種別 && hasCommonMarkers(raw)) {
  // 旧形式: frontmatter なしでマーカーが入っている → common-block-edit とみなす
  resolvedType = 'common-block-edit';
} else {
  // 種別不明: AGENTS_COMMON.md を書き換えずにスキップ（事故防止）
  console.error(
    `[skip] ${proposalId}: 種別が不明です（frontmatter に "種別: common-block-edit" または ` +
    `"種別: shared-file" がなく、共通ブロックマーカーも見当たりません）。` +
    `AGENTS_COMMON.md は変更しません。`,
  );
  process.exit(1);
}

// ── common-block-edit 処理 ───────────────────────────────────────────────────
if (resolvedType === 'common-block-edit') {
  // マーカー行を除いた本文
  const body = raw
    .split('\n')
    .filter((l) => !l.startsWith(COMMON_START) && l.trim() !== COMMON_END)
    .join('\n')
    .trim();

  if (!body) {
    console.error(`[error] ${proposalId}: 提案本文が空です`);
    process.exit(1);
  }

  const existing = existsSync(commonPath) ? readFileSync(commonPath, 'utf8') : '';
  checkDeletionRatio(existing, body, proposalId);

  writeFileSync(commonPath, body + '\n');
  rmSync(chosen.file);

  const out = process.env.GITHUB_OUTPUT;
  if (out) {
    appendFileSync(out, `found=true\n`);
    appendFileSync(out, `type=common-block-edit\n`);
    appendFileSync(out, `consumer=${chosen.repo}\n`);
    appendFileSync(out, `consumer_dir=${path.join(consumersRoot, chosen.repo)}\n`);
    appendFileSync(out, `proposal=${chosen.name}\n`);
  }
  console.log(`[common-block-edit] applied ${proposalId}`);
}

// ── shared-file 処理 ─────────────────────────────────────────────────────────
if (resolvedType === 'shared-file') {
  const targetRel = meta['対象パス'] || '';
  if (!targetRel) {
    console.error(`[error] ${proposalId}: shared-file 提案に "対象パス:" がありません`);
    process.exit(1);
  }

  // パストラバーサル防止: 解決後パスが shared/ 配下であることを確認
  const sharedRoot = path.resolve(aiOpsRoot, 'shared');
  const targetAbs  = path.resolve(sharedRoot, targetRel);
  if (!targetAbs.startsWith(sharedRoot + path.sep) && targetAbs !== sharedRoot) {
    console.error(`[error] ${proposalId}: 対象パス "${targetRel}" が shared/ 外を指しています`);
    process.exit(1);
  }

  const fileBody = stripFrontmatter(raw);
  if (!fileBody) {
    console.error(`[error] ${proposalId}: ファイル本文が空です`);
    process.exit(1);
  }

  mkdirSync(path.dirname(targetAbs), { recursive: true });
  writeFileSync(targetAbs, fileBody + '\n');
  rmSync(chosen.file);

  const out = process.env.GITHUB_OUTPUT;
  if (out) {
    appendFileSync(out, `found=true\n`);
    appendFileSync(out, `type=shared-file\n`);
    appendFileSync(out, `consumer=${chosen.repo}\n`);
    appendFileSync(out, `consumer_dir=${path.join(consumersRoot, chosen.repo)}\n`);
    appendFileSync(out, `proposal=${chosen.name}\n`);
    appendFileSync(out, `shared_path=${targetRel}\n`);
  }
  console.log(`[shared-file] applied ${proposalId} → shared/${targetRel}`);
}
