#!/usr/bin/env node
/**
 * Audits the index: every stored exchanges.archive_path must be readable under
 * the shared-mode read policy (src/read-policy.ts). Prints counts and at most
 * 10 offending directory prefixes (never transcript content); exits 1 if any.
 *
 * Usage: npx tsx scripts/audit-archive-paths.mjs
 */
import path from 'node:path';
import Database from 'better-sqlite3';
import { getDbPath } from '../src/paths.ts';
import { getReadableRoots, resolveReadablePath } from '../src/read-policy.ts';

const MAX_SAMPLES = 10;
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
let bad = 0;
for (const { archive_path: p } of rows) {
  try {
    resolveReadablePath(p, roots);
  } catch (err) {
    bad++;
    reasons.set(err.message.replace(p, '<path>'), (reasons.get(err.message.replace(p, '<path>')) ?? 0) + 1);
    // directory up to the project folder: parent of the file, never the file name
    if (prefixes.size < MAX_SAMPLES) prefixes.add(path.dirname(p));
  }
}

console.log(`readable roots: ${roots.length}`);
console.log(`distinct archive paths: ${rows.length}`);
console.log(`not readable under policy: ${bad}`);
for (const [reason, n] of reasons) console.log(`  ${n} x ${reason}`);
for (const p of prefixes) console.log(`  offending prefix: ${p}`);
process.exit(bad > 0 ? 1 : 0);
