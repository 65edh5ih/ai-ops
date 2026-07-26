#!/usr/bin/env node

// Create one collision-resistant task-history fragment in the current repository.
// Usage: scripts/new-task-history.mjs <task-slug> <short title>

import { closeSync, mkdirSync, openSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

const [, , rawSlug, ...titleParts] = process.argv;
const title = titleParts.join(' ').trim();

if (!rawSlug || !title) {
  console.error('usage: scripts/new-task-history.mjs <task-slug> <short title>');
  process.exit(2);
}

const slug = rawSlug
  .normalize('NFKD')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 60)
  .replace(/-+$/g, '');

if (!slug) {
  console.error('task-slug must contain at least one ASCII letter or digit');
  process.exit(2);
}
if (/\r|\n/.test(title)) {
  console.error('short title must be one line');
  process.exit(2);
}

const now = new Date();
const iso = now.toISOString();
const date = iso.slice(0, 10);
const timestamp = `${date}T${iso.slice(11, 19).replaceAll(':', '')}Z`;
const inbox = path.join(process.cwd(), 'docs', 'history-inbox');
mkdirSync(inbox, { recursive: true });

// O_EXCL (the "x" flag) prevents accidental overwrite in this checkout. The
// random suffix prevents independently-created branches from choosing the same path.
for (let attempt = 0; attempt < 10; attempt++) {
  const id = randomBytes(6).toString('hex');
  const relativePath = path.posix.join('docs', 'history-inbox', `${timestamp}-${slug}-${id}.md`);
  const absolutePath = path.join(process.cwd(), ...relativePath.split('/'));

  let fd;
  try {
    fd = openSync(absolutePath, 'wx', 0o644);
  } catch (error) {
    if (error?.code === 'EEXIST') continue;
    throw error;
  }

  try {
    writeFileSync(fd, `## ${date} ${title}\n\n`, 'utf8');
  } finally {
    closeSync(fd);
  }
  console.log(relativePath);
  process.exit(0);
}

console.error('failed to allocate a unique history filename after 10 attempts');
process.exit(1);
