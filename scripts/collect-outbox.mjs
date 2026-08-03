// consumer → ops-sync の「上り」経路。
// 各 consumer の .ops-sync/outbox/*.md を拾い、種別に応じて処理する:
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
// 不正な提案（種別不明・必須項目の欠落・パス不正・空本文・削除率超過）は、`.ops-sync/outbox/rejected/`
// へエラーノート付きで**差し戻す**（cleanup PR に含まれる）。以前は exit 1 で放置していたため、
// 壊れた提案が最古に居座って後続の全提案を人間の介入まで止めていた。
//
// 使い方: node collect-outbox.mjs <AGENTS_COMMON.md path> <consumers checkout root> [<ops-sync root>]
//   consumers root の構造: <root>/<owner>/<repo>/.ops-sync/outbox/*.md
//   環境変数 PR_BODY_PATH / CLEANUP_BODY_PATH があれば、取り込み PR / cleanup PR の本文を書き出す。
import {
  readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, rmSync, appendFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

const COMMON_START = '<!-- OPS-SYNC:COMMON START';
const COMMON_END   = '<!-- OPS-SYNC:COMMON END -->';

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

const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---\r?\n/;

// frontmatter だけを除いた本文（**trim しない**）。バイトが意味を持つ用途で使う。
function stripFrontmatterRaw(text) {
  return text.replace(FRONTMATTER_RE, '');
}

// frontmatter を除いた本文を**バイトのまま**返す（shared-file 用）。
// utf8 で読んだ文字列から切り出すと、不正な UTF-8 バイトが U+FFFD に化けたまま書き込まれ、
// 「バイトそのまま」の保証が破れる（`ff fe 41` → `ef bf bd ef bf bd 41`）。
// latin1 はバイトと文字が 1:1 に対応するので、境界の**バイト位置**をこれで求めて Buffer を切る
// （frontmatter の区切りは ASCII のみ。UTF-8 の継続バイトは必ず 0x80 以上なので、多バイト文字の
// 内部が `\n` や `-` と誤認されることはない）。
function stripFrontmatterBytes(buf) {
  const m = buf.toString('latin1').match(FRONTMATTER_RE);
  return m ? buf.subarray(Buffer.byteLength(m[0], 'latin1')) : buf;
}

// 空とみなす本文（空 or ASCII 空白のみ）。上と同じ理由で文字列に変換せずバイトで見る。
function isBlankBytes(buf) {
  return buf.every((b) => b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d);
}

// frontmatter を除いた本文（前後の空白を落とす）。埋め込み・比較用。
function stripFrontmatter(text) {
  return stripFrontmatterRaw(text).trim();
}

// 鮮度検査に使う内容ハッシュ（docs/outbox-proposal.md の「ベース」欄と同じ計算）。
// common-block-edit 用。AGENTS.md のマーカー間から切り出す都合で前後の空白が必ず変わるため trim する。
function hash12(text) {
  return createHash('sha256').update(text.trim()).digest('hex').slice(0, 12);
}

// shared-file 用。こちらは**バイト一致で配る実ファイル**そのものなので、切り出しが無く trim する
// 理由が無い。trim すると「末尾改行だけが変わった」ような境界だけの変更を検出できず、鮮度検査を
// すり抜けた全文置換がその変更を黙って巻き戻す。
function hashBytes12(buf) {
  return createHash('sha256').update(buf).digest('hex').slice(0, 12);
}

// 提案ファイル名 → ブランチ名の一部（バッチの先頭提案から作る。同じバッチを再処理しても
// 同じブランチになり、open のままの PR を force-push で更新する）
function branchSlug(name) {
  const slug = name.replace(/\.md$/i, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50);
  return slug || 'proposal';
}

// 削除率チェック: 既存行数に対して削除が DELETE_RATIO_LIMIT を超える提案は差し戻す
const DELETE_RATIO_LIMIT = 0.5;

// 常時層（AGENTS_COMMON.md）の 1 提案あたりの純増がこれを超えたら自動マージせず人間に回す。
// この区間は全 consumer・全エージェントの全タスクのコンテキストに常時乗るので、増やす判断は
// 「その内容が正しいか」とは別に「常時払うコストに見合うか」の判断で、機械には決められない。
// 現状 1 万文字弱の区間に対する目安として、節が 1 つ増える規模＝要レビューに置いている。
const COMMON_GROWTH_LIMIT = 800;
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
  console.error('usage: node collect-outbox.mjs <AGENTS_COMMON.md> <consumers root> [<ops-sync root>]');
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
    const outbox = path.join(consumersRoot, owner, repo, '.ops-sync', 'outbox');
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
const rejectedDir = path.join(consumerDir, '.ops-sync', 'outbox', 'rejected');

// 処理対象の consumer が決まった時点で先に出しておく。以降このスクリプトの出力には提案のファイル名・
// 却下理由（＝提案元 consumer の中身）が混ざるので、**途中で落ちても**ワークフローが詳細ログの
// 送り先を知っていなければならない（→ shared/docs/ci-logs.md 手順A-6）。最後の emitOutputs では
// このキーを再送しない。
emitOutputs({ consumer: consumerRepo, consumer_dir: consumerDir });

const KNOWN = ['common-block-edit', 'shared-file', 'task', 'task-done'];
const applied = [];   // { name, type, title, section }
const rejected = [];  // { name, reason }
const deferred = [];  // { name, reason }
let commonEditDone = false;
let staleMismatch = false;
const sharedPathsDone = new Set();

// 自動マージを保留する理由（1件でもあれば取り込み PR は人間のレビュー待ちにする）。
// 「機械が安全と確認できたものだけ自動で入れる」であって「危なそうなものを弾く」ではないので、
// 判定不能（ベース欄が無い等）は保留側に倒す——判定不能を「問題なし」と読み替えない。
const holds = [];
function hold(p, reason) {
  holds.push(`${p.name}: ${reason}`);
}

// ── 提案元の可視性による関門 ────────────────────────────────────────────────
// 提案内容の承認は、提案元でオーナーが提案ファイルを含む PR を main へマージした時点で済んでいる
// （→ docs/outbox-proposal.md の完了条件）。取り込み PR の自動マージは、同じ変更を二度承認させない
// ための自動化であって、承認の省略ではない。
// ただしこれが成り立つのは「main に載った内容の出所がオーナーに限られる」場合だけで、public repo は
// 不特定の第三者が fork/PR で内容を持ち込める。よって提案元が public なら種別によらず人間のレビューへ回す
// （→ ops-sync-design.md「上りの認可」）。
//
// 空の PUBLIC_CONSUMERS には「public が1つも無い」と「そもそも判定していない」の2通りがあり、
// 区別せず前者に倒すと、可視性を引けなかった run で関門が黙って消える。判定を通ったことを
// VISIBILITY_CHECKED で別に受け取り、通っていなければ**全 consumer を public 扱い**にする（fail closed）。
const visibilityChecked = process.env.VISIBILITY_CHECKED === 'true';
const publicConsumers = new Set(
  (process.env.PUBLIC_CONSUMERS || '').split(/\s+/).map((s) => s.trim()).filter(Boolean),
);
const isPublicSource = (repo) => !visibilityChecked || publicConsumers.has(repo);

// 不正な提案を outbox/rejected/ へ移し、先頭にエラーノートを付ける
function reject(p, reason, extra) {
  // **バイトのまま差し戻す**（MUST NOT: utf8 でデコードする）。`shared-file` の本文は非 UTF-8 を
  // 含みうるので、utf8 で読むと U+FFFD に化けたものが consumer の main に書き戻る。却下は
  // 「ヘッダを直して出し直す」ための経路なので、ここでバイトが変わると同じ内容を再提出できない
  // （提案者は過去リビジョンから復元する羽目になる）。→ shared/docs/ops-sync-design.md の書き込み不変条件
  const original = readFileSync(p.file);
  const note = [
    '> [!CAUTION]',
    `> **ops-sync の collect が差し戻した提案です**（${new Date().toISOString().slice(0, 10)}）。このディレクトリのファイルは処理されません。`,
    `> 却下理由: ${reason}`,
    extra ? `> ${extra}` : null,
    '> 修正のうえ、新しいファイル名で `.ops-sync/outbox/` に置き直してください。',
    '',
    '',
  ].filter((l) => l !== null).join('\n');
  mkdirSync(rejectedDir, { recursive: true });
  writeFileSync(path.join(rejectedDir, p.name), Buffer.concat([Buffer.from(note, 'utf8'), original]));
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
        '意図的な大幅削減であれば、オーナーに ops-sync 側での手動適用を依頼してください。',
      );
      continue;
    }

    // 鮮度検査: 全文置換なので、古い版ベースの提案を取り込むとその間の変更が黙って巻き戻る
    const currentHash = hash12(existing);
    const baseHash = meta['ベース'] || '';
    let staleNote = null;
    if (!baseHash) {
      staleNote = '- ⚠ 提案に `ベース:`（編集元ブロックのハッシュ）がありません。鮮度を機械判定できないため、差分をよく確認してください。';
      hold(p, 'ベース欄が無く鮮度を機械判定できない');
    } else if (baseHash !== currentHash) {
      staleMismatch = true;
      staleNote =
        `- ⚠ **ベース不一致**: 提案のベース \`${baseHash}\` が現在の正本 \`${currentHash}\` と一致しません。` +
        '提案が書かれた後に正本が変わっています。**このままマージするとその間の変更が巻き戻る**ため、差分を必ず確認してください。';
      hold(p, `ベース不一致（提案 ${baseHash} / 現在 ${currentHash}）`);
    }

    // 常時層サイズの計測: この区間は全 consumer・全エージェントの全タスクのコンテキストに常時乗る。
    // 肥大化をマージ判断の場で見えるようにする（トークンは日本語主体の粗い概算: 2文字≒1トークン）。
    const delta = newText.length - existing.trim().length;
    const sizeLine =
      `- 常時層サイズ: ${fmtNum(existing.trim().length)} → ${fmtNum(newText.length)} 文字` +
      `（${fmtDelta(delta)} 文字・概算 ${fmtDelta(Math.round(delta / 2))} トークン）。` +
      'この区間は全 consumer・全エージェントの全タスクに常時ロードされます。';
    if (delta > COMMON_GROWTH_LIMIT) {
      hold(p, `常時層が ${fmtDelta(delta)} 文字（上限 ${fmtNum(COMMON_GROWTH_LIMIT)}）`);
    }

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
    // **trim しない**（MUST）。shared-file はバイト一致で配る実ファイルそのもので、ベースハッシュも
    // バイト厳密に取っている。ここで trim して `+ '\n'` で書くと、提案本文と違うバイトが書き込まれ、
    // 「ベースが一致したので安全」と判定した後に境界バイトを黙って書き換えることになる。
    // 提案ファイルを**バイトで読み直す**（`raw` は utf8 デコード済みで、不正な UTF-8 が
    // U+FFFD に置き換わっている。frontmatter は自前の書式なので utf8 の `raw` から読んでよい）
    const fileBody = stripFrontmatterBytes(readFileSync(p.file));
    if (isBlankBytes(fileBody)) {
      reject(p, 'ファイル本文が空です');
      continue;
    }

    // 鮮度検査: common-block-edit と同じ理由（全文置換なので、古い版ベースの提案を取り込むと
    // その間の変更が黙って巻き戻る）。提案側は**配布された自分のコピー**（consumer の `<対象パス>`）を
    // ハッシュするが、apply-shared.mjs がバイト一致でコピーするので shared/<対象パス> と同値になる。
    // 提案元に最新の配布が届いていない状態で書かれた提案も不一致になるが、巻き戻る危険は同じなので
    // 区別せず要確認にする。
    const existingFile = existsSync(targetAbs) ? readFileSync(targetAbs) : null;
    const baseHash = meta['ベース'] || '';
    let staleNote = null;
    if (existingFile === null) {
      // 新規追加。差し替える既存内容が無く鮮度の概念が無いので、ベース無しが正常
      if (baseHash) {
        staleMismatch = true;
        staleNote =
          `- ⚠ **ベース不一致**: 提案は \`${baseHash}\` をベースとしていますが、\`shared/${targetRel}\` は現在存在しません。` +
          '新規追加として扱いますが、対象パスの誤りか、提案後にファイルが削除された可能性があるため確認してください。';
        hold(p, `ベース付きだが shared/${targetRel} が存在しない`);
      }
    } else {
      const currentHash = hashBytes12(existingFile);
      if (!baseHash) {
        staleNote = '- ⚠ 提案に `ベース:`（編集元ファイルのハッシュ）がありません。鮮度を機械判定できないため、差分をよく確認してください。';
        hold(p, 'ベース欄が無く鮮度を機械判定できない');
      } else if (baseHash !== currentHash) {
        staleMismatch = true;
        staleNote =
          `- ⚠ **ベース不一致**: 提案のベース \`${baseHash}\` が現在の \`shared/${targetRel}\` \`${currentHash}\` と一致しません。` +
          '提案が書かれた後に正本が変わっています。**このままマージするとその間の変更が巻き戻る**ため、差分を必ず確認してください。';
        hold(p, `ベース不一致（提案 ${baseHash} / 現在 ${currentHash}）`);
      }
    }

    mkdirSync(path.dirname(targetAbs), { recursive: true });
    writeFileSync(targetAbs, fileBody); // 提案本文をそのまま（→ 上のコメント）
    rmSync(p.file);
    sharedPathsDone.add(targetAbs);
    applied.push({
      name: p.name,
      type,
      title: `chore: shared/${targetRel} を更新 (${consumerRepo})`,
      section: [
        `\`shared/${targetRel}\` を提案内容で置き換えます（全文置換）。`,
        staleNote,
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

    // 提案ファイル名（秒精度の時刻＋説明）をそのまま宛先名に使うので、別 consumer が同じ対象へ
    // 同名で出すと**既存の未消化タスクを黙って上書き**する（消えたタスクには task-done も出ない）。
    // 上書きが妥当かは中身を読まないと決められないので、機械では判断せず人間に回す。
    const dest = path.resolve(aiOpsRoot, 'tasks', targetRepo, p.name);
    if (existsSync(dest)) {
      hold(p, `tasks/${targetRepo}/${p.name} が既に存在します（未消化タスクの上書きになります）`);
    }
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
        `\`${targetRepo}\` の \`.ops-sync/tasks/${p.name}\` へ配布します（同期 PR のマージ後、`,
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
      note = `\`tasks/${consumerRepo}/${fileName}\` を削除します。次回 sync で consumer 側の \`.ops-sync/tasks/\` からも消えます。`;
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
// cleanup ブランチ名に**提案ファイル名由来の値を使わない**（MUST NOT: 素のハッシュも含む）。ブランチ名は
// ops-sync（public）のジョブログにそのまま出る（`uses:` ステップの with: は必ずログに出るうえ、
// `gh pr merge` も出す）。提案ファイル名は「日時＋人が読めるスラッグ」で推測できるので、鍵の無い
// 12桁ハッシュでは総当たりで一致させられる＝秘匿になっていない（→ shared/docs/ci-logs.md 手順A-6）。
// consumer 名は `consumers.txt` で既に公開されているので、これを使えば新しい情報は漏れない。
// 1 run = 1 consumer 分のバッチなので、consumer ごとに固定でも「同じ相手の掃除 PR を再利用する」
// 性質は保たれる（むしろバッチ先頭が変わるたびに2本目の掃除 PR ができる問題も消える）。
// 取り込み（intake）側は public な ops-sync に立てるブランチで、提案内容自体が公開 PR になるため slug のまま。
const cleanupSlug = consumerRepo.split('/')[1] || 'consumer';
const titlePrefix = staleMismatch ? '[要確認: ベース不一致] ' : '';
const prTitle = applied.length === 1
  ? `${titlePrefix}${applied[0].title}`
  : `${titlePrefix}chore: outbox 提案を取り込み (${consumerRepo}・${applied.length}件)`;

// 提案元が public なら、個々の提案の中身によらず run 全体を人間のレビューに回す
if (applied.length && isPublicSource(consumerRepo)) {
  holds.push(
    visibilityChecked
      ? '提案元が public リポジトリです。main への書き込み権をオーナー確認の代わりにできないため、種別によらず人間のレビューに回します。'
      : '提案元の可視性を判定できませんでした。public の可能性を排除できないため、安全側で人間のレビューに回します。',
  );
}

// 自動マージの可否。「保留理由が1つも無い」ときだけ自動で入れる（保留側に倒す既定）
const autoMerge = applied.length > 0 && holds.length === 0;

const intakeBody = [
  `\`${consumerRepo}\` の outbox 提案 ${applied.length} 件を取り込みます。`,
  '',
  autoMerge
    ? '**この PR は自動マージされます**（全提案について、ベースハッシュが現在の正本と一致し、' +
      '常時層の増加も上限内であることを機械的に確認済み。提案内容の承認は、提案元 ' +
      `\`${consumerRepo}\` でオーナーがこの提案ファイルを含む PR を main へマージした時点で` +
      '済んでいます——この PR はその変更を正本へ反映するだけで、同じ変更を二度承認させないための自動化です）。'
    : ['> [!IMPORTANT]',
       '> **自動マージしません。オーナーのレビューが要ります。** 保留理由:',
       '>',
       ...holds.map((h) => `> - ${h}`),
      ].join('\n'),
  '',
  ...applied.map((a) => `### \`${a.name}\`（${a.type}）\n\n${a.section}`),
  '',
  '---',
  `- 提案元: \`${consumerRepo}\` の \`.ops-sync/outbox/\`（処理済み提案の削除・差し戻しは別途の cleanup PR で行います）`,
  '- この PR をマージすると、sync workflow が全 consumer へ配布します。',
  '- 内容に問題があれば**マージせず close** してください（提案本文はこの PR の差分に保存されています）。' +
    '提案元 consumer の outbox 掃除 PR も close してください。',
].join('\n');

const cleanupTitle =
  applied.length && rejected.length
    ? `chore: ops-sync 提案の outbox 整理（取り込み${applied.length}件・差し戻し${rejected.length}件）`
    : rejected.length
      ? `chore: 不正な ops-sync 提案を outbox/rejected/ へ差し戻し（${rejected.length}件）`
      : `chore: 取り込み済みの ops-sync 提案を outbox から削除（${applied.length}件）`;

const cleanupBody = [
  'ops-sync の collect workflow が outbox を処理した結果です。',
  '',
  applied.length ? '取り込み済み（ops-sync 側に取り込み PR を作成済み。outbox から削除）:' : null,
  ...applied.map((a) => `- \`${a.name}\``),
  rejected.length ? '\n差し戻し（不正な提案。`.ops-sync/outbox/rejected/` へ移動。冒頭のエラーノートを読んで、修正のうえ新しいファイル名で置き直してください）:' : null,
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
  // consumer / consumer_dir は上（consumer 確定時）で出済み——同じキーを2度書かない
  proposal: batch.map((p) => p.name).join(', '),
  applied: String(applied.length),
  rejected: String(rejected.length),
  deferred: String(deferred.length),
  branch: `ops-sync/intake-${slug}`,
  cleanup_branch: `ops-sync/cleanup-${cleanupSlug}`,
  pr_title: prTitle,
  cleanup_title: cleanupTitle,
  auto_merge: autoMerge ? 'true' : 'false',
  // 保留理由は提案名を含む＝提案元 consumer の中身なので、public な ops-sync のジョブログ・
  // ロールアップには出さない（→ docs/ci-logs.md「ログの公開先」）。件数だけ output に出し、
  // 理由の全文は取り込み PR 本文と、提案元 consumer の ci-logs に出る処理ログで読む。
  hold_count: String(holds.length),
});
if (applied.length) writeBody('PR_BODY_PATH', intakeBody);
writeBody('CLEANUP_BODY_PATH', cleanupBody);

// 保留理由は提案名を含むので、この詳細ログは提案元 consumer の ci-logs にだけ出る（workflow 側で
// ジョブログへは出さない）。ここに出しておかないと「なぜ自動マージされなかったか」がどこにも残らない
for (const h of holds) console.log(`[hold] ${consumerRepo} ${h}`);

console.log(
  `processed ${consumerRepo}: applied=${applied.length} rejected=${rejected.length} deferred=${deferred.length} ` +
  `auto_merge=${autoMerge}${holds.length ? ` (holds=${holds.length})` : ''}` +
  (proposals.length > batch.length ? ` (other consumers pending: ${proposals.length - batch.length})` : ''),
);
