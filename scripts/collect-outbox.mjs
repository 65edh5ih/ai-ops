// consumer → ai-ops の「上り」経路。
// 各 consumer の .ai-ops/outbox/*.md を1件拾い、種別に応じて処理する:
//   - common-block-edit : AGENTS_COMMON.md を全文置換（ベースハッシュで鮮度を検査）
//   - shared-file       : shared/<対象パス> にファイルを配置
//   - task              : tasks/<対象リポジトリ>/ に依頼ファイルを登録（sync で対象へ配布）
//   - task-done         : tasks/<提案元リポジトリ>/<対象ファイル> を削除（消化の報告）
// 種別が不明な提案（frontmatter 未記載かつマーカー不在）は安全のため取り込まずスキップ。
//
// 1 回の実行で 1 件だけ処理する（編集を直列化し複数提案が潰し合うのを防ぐ）。
// 未処理の提案は、その cleanup PR がマージされた後の実行で順に処理される。
//
// 使い方: node collect-outbox.mjs <AGENTS_COMMON.md path> <consumers checkout root> [<ai-ops root>]
//   consumers root の構造: <root>/<owner>/<repo>/.ai-ops/outbox/*.md
//   環境変数 PR_BODY_PATH があれば、取り込み PR の本文をそのパスへ書き出す。
import {
  readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, rmSync, appendFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

const COMMON_START = '<!-- AI-OPS:COMMON START';
const COMMON_END   = '<!-- AI-OPS:COMMON END -->';

// 共通ブロック全文に必須のマーカーが両方あるか
function hasCommonMarkers(text) {
  return text.includes(COMMON_START) && text.includes(COMMON_END);
}

// 先頭の YAML frontmatter を解析して { 種別, 対象パス, ... } を返す
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

// 鮮度検査に使う内容ハッシュ（docs/outbox-proposal.md の「ベース」欄と同じ計算）
function hash12(text) {
  return createHash('sha256').update(text.trim()).digest('hex').slice(0, 12);
}

// 提案ファイル名 → ブランチ名の一部（提案ごとに別ブランチにして、前の提案の
// 取り込み PR が open のまま次を処理しても force-push で潰さない）
function branchSlug(name) {
  const slug = name.replace(/\.md$/i, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50);
  return slug || 'proposal';
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

function emitOutputs(kv) {
  const out = process.env.GITHUB_OUTPUT;
  if (!out) return;
  for (const [k, v] of Object.entries(kv)) appendFileSync(out, `${k}=${v}\n`);
}

function emitPrBody(text) {
  const p = process.env.PR_BODY_PATH;
  if (p) writeFileSync(p, text);
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
const 理由 = meta['理由'] || '';

// ── 種別判定 ──────────────────────────────────────────────────────────────────
// 明示 frontmatter があればそれを優先。
// frontmatter がなければマーカー存在をフォールバック判定（後方互換）。
const KNOWN = ['common-block-edit', 'shared-file', 'task', 'task-done'];
let resolvedType;
if (KNOWN.includes(種別)) {
  resolvedType = 種別;
} else if (!種別 && hasCommonMarkers(raw)) {
  // 旧形式: frontmatter なしでマーカーが入っている → common-block-edit とみなす
  resolvedType = 'common-block-edit';
} else {
  // 種別不明: 何も書き換えずにスキップ（事故防止）
  console.error(
    `[skip] ${proposalId}: 種別が不明です（frontmatter の "種別:" が ${KNOWN.join(' / ')} のいずれでもなく、` +
    `共通ブロックマーカーも見当たりません）。何も変更しません。`,
  );
  process.exit(1);
}

const slug = branchSlug(chosen.name);
const common = {
  found: 'true',
  type: resolvedType,
  consumer: chosen.repo,
  consumer_dir: path.join(consumersRoot, chosen.repo),
  proposal: chosen.name,
  branch: `ai-ops/intake-${slug}`,
  cleanup_branch: `ai-ops/cleanup-${slug}`,
};
const bodyFooter = [
  '',
  '---',
  `- 提案元: \`${chosen.repo}\` の \`.ai-ops/outbox/${chosen.name}\``,
  理由 ? `- 提案の理由: ${理由}` : null,
  '- この PR をマージすると、sync workflow が全 consumer へ配布します。',
  '- 内容に問題があれば**マージせず close** してください（提案本文はこの PR の差分に保存されています）。' +
    '別途立っている提案元 consumer の outbox 掃除 PR も close してください。',
].filter((l) => l !== null).join('\n');

// ── common-block-edit 処理 ───────────────────────────────────────────────────
if (resolvedType === 'common-block-edit') {
  // マーカー行を除いた本文
  const body = raw
    .split('\n')
    .filter((l) => !l.startsWith(COMMON_START) && l.trim() !== COMMON_END)
    .join('\n');
  const newText = stripFrontmatter(body);

  if (!newText) {
    console.error(`[error] ${proposalId}: 提案本文が空です`);
    process.exit(1);
  }

  const existing = existsSync(commonPath) ? readFileSync(commonPath, 'utf8') : '';
  checkDeletionRatio(existing, newText, proposalId);

  // 鮮度検査: 提案が「どの版のブロックを編集したか」を現在の正本と突き合わせる。
  // 全文置換なので、古い版ベースの提案をそのまま取り込むと新しい変更が黙って巻き戻る。
  const currentHash = hash12(existing);
  const baseHash = meta['ベース'] || '';
  let staleNote = '';
  let titlePrefix = '';
  if (!baseHash) {
    staleNote = '- ⚠ 提案に `ベース:`（編集元ブロックのハッシュ）がありません。鮮度を機械判定できないため、差分をよく確認してください。';
  } else if (baseHash !== currentHash) {
    titlePrefix = '[要確認: ベース不一致] ';
    staleNote =
      `- ⚠ **ベース不一致**: 提案のベース \`${baseHash}\` が現在の正本 \`${currentHash}\` と一致しません。` +
      '提案が書かれた後に正本が変わっています。**このままマージするとその間の変更が巻き戻る**ため、差分を必ず確認してください。';
  }

  writeFileSync(commonPath, newText + '\n');
  rmSync(chosen.file);

  emitOutputs({ ...common, pr_title: `${titlePrefix}chore: 共通ルール提案を取り込み (${chosen.repo})` });
  emitPrBody([
    '`AGENTS_COMMON.md`（共通ブロックの正本）への提案を反映します。',
    staleNote,
    bodyFooter,
  ].filter(Boolean).join('\n'));
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

  emitOutputs({ ...common, shared_path: targetRel, pr_title: `chore: shared/${targetRel} を更新 (${chosen.repo})` });
  emitPrBody([
    `\`shared/${targetRel}\` を提案内容で置き換えます（全文置換）。`,
    bodyFooter,
  ].join('\n'));
  console.log(`[shared-file] applied ${proposalId} → shared/${targetRel}`);
}

// ── task 処理（別リポジトリへの作業依頼を登録）──────────────────────────────
if (resolvedType === 'task') {
  const targetRepo = meta['対象リポジトリ'] || '';
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(targetRepo)) {
    console.error(`[error] ${proposalId}: task 提案の "対象リポジトリ:" が owner/repo 形式ではありません: "${targetRepo}"`);
    process.exit(1);
  }
  // 配布先は consumers.txt に載っているリポジトリだけ（= この run で clone 済み）
  if (!existsSync(path.join(consumersRoot, targetRepo))) {
    console.error(`[error] ${proposalId}: 対象リポジトリ "${targetRepo}" は consumers.txt にありません（配布できません）`);
    process.exit(1);
  }

  const taskBody = stripFrontmatter(raw);
  if (!taskBody) {
    console.error(`[error] ${proposalId}: タスク本文が空です`);
    process.exit(1);
  }

  const dest = path.resolve(aiOpsRoot, 'tasks', targetRepo, chosen.name);
  mkdirSync(path.dirname(dest), { recursive: true });
  writeFileSync(dest, [
    '---',
    `発信元: ${chosen.repo}`,
    理由 ? `理由: ${理由}` : null,
    '---',
    '',
    taskBody,
    '',
  ].filter((l) => l !== null).join('\n'));
  rmSync(chosen.file);

  emitOutputs({ ...common, task_repo: targetRepo, pr_title: `chore: ${targetRepo} へのタスクを登録 (${chosen.repo} 発)` });
  emitPrBody([
    `\`tasks/${targetRepo}/${chosen.name}\` を登録します。マージすると sync workflow が`,
    `\`${targetRepo}\` の \`.ai-ops/tasks/${chosen.name}\` へ配布します（同期 PR のマージ後、`,
    `そのリポジトリのセッションが実行します）。`,
    bodyFooter,
  ].join('\n'));
  console.log(`[task] applied ${proposalId} → tasks/${targetRepo}/${chosen.name}`);
}

// ── task-done 処理（自リポジトリ宛タスクの消化を報告）────────────────────────
if (resolvedType === 'task-done') {
  const fileName = meta['対象ファイル'] || '';
  if (!fileName || fileName.includes('/') || fileName.includes('\\') || fileName.includes('..')) {
    console.error(`[error] ${proposalId}: task-done 提案の "対象ファイル:" が不正です: "${fileName}"`);
    process.exit(1);
  }

  // 消せるのは自分（提案元 consumer）宛のタスクだけ
  const target = path.resolve(aiOpsRoot, 'tasks', chosen.repo, fileName);
  let note;
  if (existsSync(target)) {
    rmSync(target);
    note = `\`tasks/${chosen.repo}/${fileName}\` を削除します。次回 sync で consumer 側の \`.ai-ops/tasks/\` からも消えます。`;
  } else {
    note = `\`tasks/${chosen.repo}/${fileName}\` は既に存在しません（差分なし・outbox の掃除のみ行います）。`;
  }
  rmSync(chosen.file);

  emitOutputs({ ...common, pr_title: `chore: ${chosen.repo} のタスク完了を反映 (${fileName})` });
  emitPrBody([note, bodyFooter].join('\n'));
  console.log(`[task-done] applied ${proposalId} (${fileName})`);
}
