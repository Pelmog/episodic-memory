#!/usr/bin/env node
/**
 * Audits the index: every stored exchanges.archive_path must be readable under
 * the shared-mode read policy (src/read-policy.ts). Prints counts and at most
 * 10 offending directory prefixes (never transcript content). Exits 1 only if
 * a path is outside the readable roots; files that no longer exist (or are not
 * .jsonl) are reported separately and do not fail the audit.
 *
 * Usage: npx tsx scripts/audit-archive-paths.mjs
 */
import path from 'node:path';
import Database from 'better-sqlite3';
import { getDbPath } from '../src/paths.ts';
import { getReadableRoots, resolveReadablePath } from '../src/read-policy.ts';

const MAX_SAMPLES = 10;
const OUTSIDE = 'Path is outside the conversation archive and transcript directories';
const dbPath = getDbPath();
const db = new Database(dbPath, { readonly: true, fileMustExist: true });
let rows;
try {
  rows = db.prepare('SELECT DISTINCT archive_path FROM exchanges').all();
} finally {
  db.close();
}

const roots = getReadableRoots();
const reasons = new Map();
const prefixes = new Set();
let outside = 0;
let missing = 0;
let other = 0;
for (const { archive_path: p } of rows) {
  try {
    if (typeof p !== 'string' || p === '') throw new Error('Empty archive path');
    resolveReadablePath(p, roots);
  } catch (err) {
    const reason = typeof p === 'string' && p !== '' ? err.message.replace(p, '<path>') : err.message;
    reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    if (err.message === OUTSIDE) {
      outside++;
      // directory up to the project folder: parent of the file, never the file name
      if (prefixes.size < MAX_SAMPLES) prefixes.add(path.dirname(p));
    } else if (err.message.startsWith('File not found: ')) {
      missing++;
    } else {
      other++;
    }
  }
}

console.log(`readable roots: ${roots.length}`);
console.log(`distinct archive paths: ${rows.length}`);
console.log(`not readable under policy: ${outside + missing + other}`);
console.log(`outside roots: ${outside}`);
console.log(`missing files: ${missing}`);
console.log(`other (not .jsonl, empty): ${other}`);
for (const [reason, n] of reasons) console.log(`  ${n} x ${reason}`);
for (const p of prefixes) console.log(`  offending prefix: ${p}`);
process.exit(outside > 0 ? 1 : 0);
