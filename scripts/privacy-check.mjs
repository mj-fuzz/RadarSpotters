#!/usr/bin/env node
// Privacy guard for Radar Spotters.
//
// Blocks commits that would leak personal info to GitHub:
//   - absolute file paths (home folders on Linux, macOS, Windows)
//   - email addresses (except GitHub/Anthropic no-reply addresses)
//   - any term in the local, never-committed `.privacy-blocklist` file
//   - a git author email that is not a no-reply address
//
// Usage:
//   node scripts/privacy-check.mjs            -> checks staged files (pre-commit hook)
//   node scripts/privacy-check.mjs --all      -> checks every tracked file
//   node scripts/privacy-check.mjs --msg FILE -> checks a commit message (commit-msg hook)
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

// Patterns are assembled from pieces so this file does not flag itself.
const SLASH = '/';
const BS = '\\\\';
const patterns = [
  { name: 'Linux home path', re: new RegExp(SLASH + 'home' + SLASH + '[A-Za-z0-9._-]+', 'g') },
  { name: 'macOS home path', re: new RegExp(SLASH + 'Users' + SLASH + '[A-Za-z0-9._-]+', 'g') },
  { name: 'Windows user path', re: new RegExp('[A-Za-z]:' + BS + 'Users' + BS + '[A-Za-z0-9._ -]+', 'gi') },
  { name: 'Windows user path', re: new RegExp('[A-Za-z]:' + SLASH + 'Users' + SLASH + '[A-Za-z0-9._ -]+', 'gi') },
  { name: 'root home path', re: new RegExp(SLASH + 'root' + SLASH + '[A-Za-z0-9._-]+', 'g') },
];
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const ALLOWED_EMAIL = [/@users\.noreply\.github\.com$/i, /^noreply@anthropic\.com$/i, /^noreply@github\.com$/i];

function loadBlocklist() {
  if (!existsSync('.privacy-blocklist')) return [];
  return readFileSync('.privacy-blocklist', 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((t) => t.toLowerCase());
}

function scan(label, text, blocklist) {
  const problems = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const p of patterns) {
      p.re.lastIndex = 0;
      if (p.re.test(line)) problems.push(`${label}:${i + 1}: ${p.name}`);
    }
    for (const m of line.match(EMAIL) ?? []) {
      if (!ALLOWED_EMAIL.some((re) => re.test(m))) problems.push(`${label}:${i + 1}: email address`);
    }
    const lower = line.toLowerCase();
    for (const term of blocklist) {
      if (lower.includes(term)) problems.push(`${label}:${i + 1}: blocklisted term (from .privacy-blocklist)`);
    }
  });
  return problems;
}

const args = process.argv.slice(2);
const blocklist = loadBlocklist();
let problems = [];

if (args[0] === '--msg') {
  problems = scan('commit message', readFileSync(args[1], 'utf8'), blocklist);
} else {
  const all = args[0] === '--all';
  const files = (all ? git('ls-files') : git('diff', '--cached', '--name-only', '--diff-filter=ACMR'))
    .split('\n')
    .filter(Boolean)
    .filter((f) => f !== 'package-lock.json' && !/\.(png|jpg|jpeg|gif|ico|webp|woff2?)$/i.test(f));
  for (const f of files) {
    let text;
    try {
      text = all ? readFileSync(f, 'utf8') : git('show', `:${f}`);
    } catch {
      continue;
    }
    problems.push(...scan(f, text, blocklist));
  }
  // Author identity must be a no-reply address.
  let email = '';
  try {
    email = git('config', 'user.email').trim();
  } catch {
    /* unset */
  }
  if (!all && !ALLOWED_EMAIL.some((re) => re.test(email))) {
    problems.push('git config user.email is not a no-reply address (use your GitHub noreply email)');
  }
}

if (problems.length) {
  console.error('\n🚫 Privacy check failed - nothing was committed:\n');
  for (const p of problems) console.error('  - ' + p);
  console.error('\nRemove the personal info (or use a relative path) and try again.\n');
  process.exit(1);
}
if (args[0] === '--all') console.log('✅ Privacy check passed.');
