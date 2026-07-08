// consumer → ai-ops の「上り」経路。
// 各 consumer の .ai-ops/outbox/*.md を拾い、種別に応じて処理する:
//   - common-block-edit : AGENTS_COMMON.md を全文置換（ベースハッシュで鮮度を検査）
//   - shared-file       : shared/<対象パス> にファイルを配置
//   - task              : tasks/<対象リポジトリ>/ に依頼ファイルを登録（sync で対象へ配布）
//   - task-done         : tasks/<提案元リポジトリ>/<対象ファイル> を削除（消化の報告）
//
// 処理単位: **最古の提案を持つ consumer の1つ分をまとめて**処理する（取り込み PR と cleanup PR は
// 従来どおり各1本のまま、提案が「6時間×件数」の直列待ちになるのを防ぐ）。ただし同一実行内で
// 潰し合う提案（2件目以降の common-block-edit・対象パスが重複する shared-file。いずれも全文置換）は
// 手を付けずに outbox へ残し、次回実行（cleanup PR マージ後）に回す。別 consumer の提案も次回。
//
// 不正な提案（種別不明・必須項目の欠落・パス不正・空本文・削除率超過）は、`.ai-ops/outbox/rejected/`
// へエラーノート付きで**差し戻す**（cleanup PR に含まれる）。以前は exit 1 で放置していたため、
// 壊れた提案が最古に居座って後続の全提案を人間の介入まで止めていた。
//
// 使い方: node collect-outbox.mjs <AGENTS_COMMON.md path> <consumers checkout root> [<ai-ops root>]
//   consumers root の構造: <root>/<owner>/<repo>/.ai-ops/outbox/*.md
//   環境変数 PR_BODY_PATH / CLEANUP_BODY_PATH があれば、取り込み PR / cleanup PR の本文を書き出す。
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

// 提案ファイル名 → ブランチ名の一部（バッチの先頭提案から作る。同じバッチを再処理しても
// 同じブランチになり、open のままの PR を force-push で更新する）
function branchSlug(name) {
  const slug = name.replace(/\.md$/i, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50);
  return slug || 'proposal';
}

// 削除率チェック: 既存行数に対して削除が DELETE_RATIO_LIMIT を超える提案は差し戻す
const DELETE_RATIO_LIMIT = 0.5;
function deletionRatioBreach(oldText, newText) {
  const oldLines = oldText.split('\n').length;
  const newLines = newText.split('\n').length;
  const deleted = Math.max(0, oldLines - newLines);
  if (oldLines > 10 && deleted / oldLines > DELETE_RATIO_LIMIT) {
    return Math.round((deleted / oldLines) * 100);
  }
  return 0;
}

function emitOutputs(kv) {
  const out = process.env.GITHUB_OUTPUT;
  if (!out) return;
  for (const [k, v] of Object.entries(kv)) appendFileSync(out, `${k}=${v}\n`);
}

function writeBody(envName, text) {
  const p = process.env[envName];
  if (p) writeFileSync(p, text);
}

const fmtNum = (n) => n.toLocaleString('en-US');
const fmtDelta = (n) => `${n >= 0 ? '+' : '-'}${fmtNum(Math.abs(n))}`;

const [, , commonPath, consumersRoot, aiOpsRoot = '.'] = process.argv;
if (!commonPath || !consumersRoot) {
  console.error('usage: node collect-outbox.mjs <AGENTS_COMMON.md> <consumers root> [<ai-ops root>]');
  process.exit(2);
}

function dirs(p) {
  if (!existsSync(p)) return [];
  return readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
}

// 全 consumer の outbox 提案を集める（rejected/ などのサブディレクトリは対象外）
const proposals = [];
for (const owner of dirs(consumersRoot)) {
  for (const repo of dirs(path.join(consumersRoot, owner))) {
    const outbox = path.join(consumersRoot, owner, repo, '.ai-ops', 'outbox');
    if (!existsSync(outbox)) continue;
    for (const e of readdirSync(outbox, { withFileTypes: true })) {
      if (!e.isFile() || !e.name.endsWith('.md')) continue;
      proposals.push({ repo: `${owner}/${repo}`, file: path.join(outbox, e.name), name: e.name });
    }
  }
}

if (proposals.length === 0) {
  console.log('no proposals');
  process.exit(0);
}

// ファイル名（先頭に ISO 時刻を付ける規約）で並べ、最古の提案を持つ consumer の分をまとめて処理
proposals.sort((a, b) => a.name.localeCompare(b.name));
const consumerRepo = proposals[0].repo;
const batch = proposals.filter((p) => p.repo === consumerRepo);
const consumerDir = path.join(consumersRoot, consumerRepo);
const rejectedDir = path.join(consumerDir, '.ai-ops', 'outbox', 'rejected');

const KNOWN = ['common-block-edit', 'shared-file', 'task', 'task-done'];
const applied = [];   // { name, type, title, section }
const rejected = [];  // { name, reason }
const deferred = [];  // { name, reason }
let commonEditDone = false;
let staleMismatch = false;
const sharedPathsDone = new Set();

// 不正な提案を outbox/rejected/ へ移し、先頭にエラーノートを付ける
function reject(p, reason, extra) {
  const original = readFileSync(p.file, 'utf8');
  const note = [
    '> [!CAUTION]',
    `> **ai-ops の collect が差し戻した提案です**（${new Date().toISOString().slice(0, 10)}）。このディレクトリのファイルは処理されません。`,
    `> 却下理由: ${reason}`,
    extra ? `> ${extra}` : null,
    '> 修正のうえ、新しいファイル名で `.ai-ops/outbox/` に置き直してください。',
    '',
    '',
  ].filter((l) => l !== null).join('\n');
  mkdirSync(rejectedDir, { recursive: true });
  writeFileSync(path.join(rejectedDir, p.name), note + original);
  rmSync(p.file);
  rejected.push({ name: p.name, reason });
  console.error(`[reject] ${consumerRepo}/${p.name}: ${reason}`);
}

function defer(p, reason) {
  deferred.push({ name: p.name, reason });
  console.log(`[defer] ${consumerRepo}/${p.name}: ${reason}`);
}

for (const p of batch) {
  const proposalId = `${consumerRepo}/${p.name}`;
  const raw = readFileSync(p.file, 'utf8');
  const meta = parseFrontmatter(raw);
  const 種別 = meta['種別'] || '';
  const 理由 = meta['理由'] || '';
  const reasonLine = 理由 ? `- 提案の理由: ${理由}` : null;

  // ── 種別判定: 明示 frontmatter を優先。無ければマーカー存在で後方互換判定 ──
  let type;
  if (KNOWN.includes(種別)) {
    type = 種別;
  } else if (!種別 && hasCommonMarkers(raw)) {
    type = 'common-block-edit'; // 旧形式: frontmatter なしでマーカー入り
  } else {
    reject(p, `種別が不明です（frontmatter の "種別:" が ${KNOWN.join(' / ')} のいずれでもなく、共通ブロックマーカーも見当たりません）`);
    continue;
  }

  // ── common-block-edit ──────────────────────────────────────────────────────
  if (type === 'common-block-edit') {
    if (commonEditDone) {
      defer(p, '同一実行内に先行の common-block-edit があるため次回に回します（全文置換どうしの衝突回避）');
      continue;
    }
    const body = raw
      .split('\n')
      .filter((l) => !l.startsWith(COMMON_START) && l.trim() !== COMMON_END)
      .join('\n');
    const newText = stripFrontmatter(body);
    if (!newText) {
      reject(p, '提案本文が空です');
      continue;
    }
    const existing = existsSync(commonPath) ? readFileSync(commonPath, 'utf8') : '';
    const breach = deletionRatioBreach(existing, newText);
    if (breach) {
      reject(
        p,
        `削除率 ${breach}% が上限 ${DELETE_RATIO_LIMIT * 100}% を超えています`,
        '意図的な大幅削減であれば、オーナーに ai-ops 側での手動適用を依頼してください。',
      );
      continue;
    }

    // 鮮度検査: 全文置換なので、古い版ベースの提案を取り込むとその間の変更が黙って巻き戻る
    const currentHash = hash12(existing);
    const baseHash = meta['ベース'] || '';
    let staleNote = null;
    if (!baseHash) {
      staleNote = '- ⚠ 提案に `ベース:`（編集元ブロックのハッシュ）がありません。鮮度を機械判定できないため、差分をよく確認してください。';
    } else if (baseHash !== currentHash) {
      staleMismatch = true;
      staleNote =
        `- ⚠ **ベース不一致**: 提案のベース \`${baseHash}\` が現在の正本 \`${currentHash}\` と一致しません。` +
        '提案が書かれた後に正本が変わっています。**このままマージするとその間の変更が巻き戻る**ため、差分を必ず確認してください。';
    }

    // 常時層サイズの計測: この区間は全 consumer・全エージェントの全タスクのコンテキストに常時乗る。
    // 肥大化をマージ判断の場で見えるようにする（トークンは日本語主体の粗い概算: 2文字≒1トークン）。
    const delta = newText.length - existing.trim().length;
    const sizeLine =
      `- 常時層サイズ: ${fmtNum(existing.trim().length)} → ${fmtNum(newText.length)} 文字` +
      `（${fmtDelta(delta)} 文字・概算 ${fmtDelta(Math.round(delta / 2))} トークン）。` +
      'この区間は全 consumer・全エージェントの全タスクに常時ロードされます。';

    writeFileSync(commonPath, newText + '\n');
    rmSync(p.file);
    commonEditDone = true;
    applied.push({
      name: p.name,
      type,
      title: `chore: 共通ルール提案を取り込み (${consumerRepo})`,
      section: [
        '`AGENTS_COMMON.md`（共通ブロックの正本）を提案内容で置き換えます（全文置換）。',
        staleNote,
        sizeLine,
        reasonLine,
      ].filter(Boolean).join('\n'),
    });
    console.log(`[common-block-edit] applied ${proposalId}`);
  }

  // ── shared-file ────────────────────────────────────────────────────────────
  if (type === 'shared-file') {
    const targetRel = meta['対象パス'] || '';
    if (!targetRel) {
      reject(p, 'shared-file 提案に "対象パス:" がありません');
      continue;
    }
    // パストラバーサル防止: 解決後パスが shared/ 配下であることを確認
    const sharedRoot = path.resolve(aiOpsRoot, 'shared');
    const targetAbs  = path.resolve(sharedRoot, targetRel);
    if (!targetAbs.startsWith(sharedRoot + path.sep) && targetAbs !== sharedRoot) {
      reject(p, `対象パス "${targetRel}" が shared/ 外を指しています`);
      continue;
    }
    if (sharedPathsDone.has(targetAbs)) {
      defer(p, `同一実行内に同じ対象パス "${targetRel}" への先行提案があるため次回に回します（全文置換どうしの衝突回避）`);
      continue;
    }
    const fileBody = stripFrontmatter(raw);
    if (!fileBody) {
      reject(p, 'ファイル本文が空です');
      continue;
    }

    mkdirSync(path.dirname(targetAbs), { recursive: true });
    writeFileSync(targetAbs, fileBody + '\n');
    rmSync(p.file);
    sharedPathsDone.add(targetAbs);
    applied.push({
      name: p.name,
      type,
      title: `chore: shared/${targetRel} を更新 (${consumerRepo})`,
      section: [
        `\`shared/${targetRel}\` を提案内容で置き換えます（全文置換）。`,
        reasonLine,
      ].filter(Boolean).join('\n'),
    });
    console.log(`[shared-file] applied ${proposalId} → shared/${targetRel}`);
  }

  // ── task（別リポジトリへの作業依頼を登録）──────────────────────────────────
  if (type === 'task') {
    const targetRepo = meta['対象リポジトリ'] || '';
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(targetRepo)) {
      reject(p, `task 提案の "対象リポジトリ:" が owner/repo 形式ではありません: "${targetRepo}"`);
      continue;
    }
    // 配布先は consumers.txt に載っているリポジトリだけ（= この run で clone 済み）
    if (!existsSync(path.join(consumersRoot, targetRepo))) {
      reject(p, `対象リポジトリ "${targetRepo}" は consumers.txt にありません（配布できません）`);
      continue;
    }
    const taskBody = stripFrontmatter(raw);
    if (!taskBody) {
      reject(p, 'タスク本文が空です');
      continue;
    }

    const dest = path.resolve(aiOpsRoot, 'tasks', targetRepo, p.name);
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, [
      '---',
      `発信元: ${consumerRepo}`,
      理由 ? `理由: ${理由}` : null,
      '---',
      '',
      taskBody,
      '',
    ].filter((l) => l !== null).join('\n'));
    rmSync(p.file);
    applied.push({
      name: p.name,
      type,
      title: `chore: ${targetRepo} へのタスクを登録 (${consumerRepo} 発)`,
      section: [
        `\`tasks/${targetRepo}/${p.name}\` を登録します。マージすると sync workflow が`,
        `\`${targetRepo}\` の \`.ai-ops/tasks/${p.name}\` へ配布します（同期 PR のマージ後、`,
        'そのリポジトリのセッションが実行します）。',
        reasonLine,
      ].filter(Boolean).join('\n'),
    });
    console.log(`[task] applied ${proposalId} → tasks/${targetRepo}/${p.name}`);
  }

  // ── task-done（自リポジトリ宛タスクの消化を報告）──────────────────────────
  if (type === 'task-done') {
    const fileName = meta['対象ファイル'] || '';
    if (!fileName || fileName.includes('/') || fileName.includes('\\') || fileName.includes('..')) {
      reject(p, `task-done 提案の "対象ファイル:" が不正です: "${fileName}"`);
      continue;
    }
    // 消せるのは自分（提案元 consumer）宛のタスクだけ
    const target = path.resolve(aiOpsRoot, 'tasks', consumerRepo, fileName);
    let note;
    if (existsSync(target)) {
      rmSync(target);
      note = `\`tasks/${consumerRepo}/${fileName}\` を削除します。次回 sync で consumer 側の \`.ai-ops/tasks/\` からも消えます。`;
    } else {
      note = `\`tasks/${consumerRepo}/${fileName}\` は既に存在しません（差分なし・outbox の掃除のみ行います）。`;
    }
    rmSync(p.file);
    applied.push({
      name: p.name,
      type,
      title: `chore: ${consumerRepo} のタスク完了を反映 (${fileName})`,
      section: [note, reasonLine].filter(Boolean).join('\n'),
    });
    console.log(`[task-done] applied ${proposalId} (${fileName})`);
  }
}

// ── PR タイトル・本文と outputs ──────────────────────────────────────────────
const slug = branchSlug(batch[0].name);
const titlePrefix = staleMismatch ? '[要確認: ベース不一致] ' : '';
const prTitle = applied.length === 1
  ? `${titlePrefix}${applied[0].title}`
  : `${titlePrefix}chore: outbox 提案を取り込み (${consumerRepo}・${applied.length}件)`;

const intakeBody = [
  `\`${consumerRepo}\` の outbox 提案 ${applied.length} 件を取り込みます。`,
  '',
  ...applied.map((a) => `### \`${a.name}\`（${a.type}）\n\n${a.section}`),
  '',
  '---',
  `- 提案元: \`${consumerRepo}\` の \`.ai-ops/outbox/\`（処理済み提案の削除・差し戻しは別途の cleanup PR で行います）`,
  '- この PR をマージすると、sync workflow が全 consumer へ配布します。',
  '- 内容に問題があれば**マージせず close** してください（提案本文はこの PR の差分に保存されています）。' +
    '提案元 consumer の outbox 掃除 PR も close してください。',
].join('\n');

const cleanupTitle =
  applied.length && rejected.length
    ? `chore: ai-ops 提案の outbox 整理（取り込み${applied.length}件・差し戻し${rejected.length}件）`
    : rejected.length
      ? `chore: 不正な ai-ops 提案を outbox/rejected/ へ差し戻し（${rejected.length}件）`
      : `chore: 取り込み済みの ai-ops 提案を outbox から削除（${applied.length}件）`;

const cleanupBody = [
  'ai-ops の collect workflow が outbox を処理した結果です。',
  '',
  applied.length ? '取り込み済み（ai-ops 側に取り込み PR を作成済み。outbox から削除）:' : null,
  ...applied.map((a) => `- \`${a.name}\``),
  rejected.length ? '\n差し戻し（不正な提案。`.ai-ops/outbox/rejected/` へ移動。冒頭のエラーノートを読んで、修正のうえ新しいファイル名で置き直してください）:' : null,
  ...rejected.map((r) => `- \`${r.name}\` — ${r.reason}`),
  deferred.length ? '\n未処理（同一実行内で衝突するため次回の collect が処理します。このファイルは outbox に残っています）:' : null,
  ...deferred.map((d) => `- \`${d.name}\``),
  '',
  applied.length ? '（取り込み PR を close した場合は、この cleanup PR も close してください。提案内容は取り込み PR の差分に残っています。）' : null,
].filter((l) => l !== null).join('\n');

emitOutputs({
  found: applied.length ? 'true' : 'false',
  consumer_changed: applied.length + rejected.length ? 'true' : 'false',
  type: applied.length === 1 ? applied[0].type : 'batch',
  consumer: consumerRepo,
  consumer_dir: consumerDir,
  proposal: batch.map((p) => p.name).join(', '),
  applied: String(applied.length),
  rejected: String(rejected.length),
  deferred: String(deferred.length),
  branch: `ai-ops/intake-${slug}`,
  cleanup_branch: `ai-ops/cleanup-${slug}`,
  pr_title: prTitle,
  cleanup_title: cleanupTitle,
});
if (applied.length) writeBody('PR_BODY_PATH', intakeBody);
writeBody('CLEANUP_BODY_PATH', cleanupBody);

console.log(
  `processed ${consumerRepo}: applied=${applied.length} rejected=${rejected.length} deferred=${deferred.length}` +
  (proposals.length > batch.length ? ` (other consumers pending: ${proposals.length - batch.length})` : ''),
);
