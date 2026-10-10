#!/usr/bin/env node
/**
 * Install the pre-push guard as this repository's pre-push hook.
 *
 * Two installation strategies, in order of preference:
 *   1. core.hooksPath  — a single config value pointing at scripts/guard;
 *                        survives re-clones, needs no file copies, and makes
 *                        `git push` use the hook file directly. Existing
 *                        hooks in that directory keep working (git runs every
 *                        executable matching the hook name there).
 *   2. file copy       — copy pre-push.mjs to .git/hooks/pre-push with a
 *                        marker banner; used when hooksPath cannot be set
 *                        (e.g. a worktree-shared config conflict) or when the
 *                        user passes --copy explicitly.
 *
 * Zero third-party dependencies. Node >= 16.
 *
 * Usage:
 *   node scripts/guard/install.mjs            # auto: hooksPath, fallback copy
 *   node scripts/guard/install.mjs --copy     # force the file-copy strategy
 *   node scripts/guard/install.mjs --status   # show current installation state
 *   node scripts/guard/install.mjs --remove   # uninstall (unset / delete copy)
 */
'use strict';

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const GUARD_DIR = dirname(fileURLToPath(import.meta.url)); // <repo>/scripts/guard
const REPO_ROOT = resolve(GUARD_DIR, '..', '..');
const HOOK_SOURCE = join(GUARD_DIR, 'pre-push.mjs');
const HOOKS_DIR_DEFAULT = join(REPO_ROOT, '.git', 'hooks');
const HOOK_TARGET = join(HOOKS_DIR_DEFAULT, 'pre-push');
/** Marker so we only ever touch a hook file this installer wrote. */
const MARKER = 'installed by scripts/guard/install.mjs';
/** Git config key used by strategy 1. */
const HOOKS_PATH_KEY = 'core.hooksPath';

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

function log(message) {
  process.stdout.write(`${message}\n`);
}

/** Run a git command; returns { code, stdout, stderr } with trimmed strings. */
function git(args) {
  const result = spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' });
  return {
    code: result.status,
    stdout: (result.stdout || '').trim(),
    stderr: (result.stderr || '').trim()
  };
}

/** Print usage and exit with the given code. */
function usage(code) {
  log('');
  log('Usage: node scripts/guard/install.mjs [--copy] [--status] [--remove] [--help]');
  log('');
  log('  (default)   install the pre-push guard (core.hooksPath first, file copy as fallback)');
  log('  --copy      force installation by copying the hook into .git/hooks/pre-push');
  log('  --status    show whether and how the guard is currently installed');
  log('  --remove    uninstall the guard (unset core.hooksPath and/or delete the copy)');
  log('  --help      show this help');
  log('');
  process.exit(code);
}

/** Parse CLI flags. */
function parseArgs(argv) {
  const flags = { copy: false, status: false, remove: false, help: false };
  for (const arg of argv) {
    if (arg === '--copy') flags.copy = true;
    else if (arg === '--status') flags.status = true;
    else if (arg === '--remove') flags.remove = true;
    else if (arg === '--help' || arg === '-h') flags.help = true;
    else {
      log(`Unknown argument: ${arg}`);
      usage(1);
    }
  }
  return flags;
}

/** True when the directory looks like this repo's scripts/guard. */
function isGuardDir(dir) {
  return existsSync(join(dir, 'pre-push.mjs'));
}

/** Current core.hooksPath value (or '' when unset). */
function getHooksPath() {
  const result = git(['config', '--get', HOOKS_PATH_KEY]);
  return result.code === 0 ? result.stdout : '';
}

/** Read the hook copy target as text, or null when missing/unreadable. */
function readHookTarget() {
  try {
    return readFileSync(HOOK_TARGET, 'utf8');
  } catch {
    return null;
  }
}

/** True when .git/hooks/pre-push is a copy (or symlink) of our guard. */
function isCopyInstalled() {
  if (!existsSync(HOOK_TARGET)) return false;
  // Symlink/hardlink straight to the source counts as installed.
  try {
    const targetStat = statSync(HOOK_TARGET);
    const sourceStat = statSync(HOOK_SOURCE);
    // ino may be 0/unreliable on some filesystems — require non-zero on both.
    if (
      targetStat.ino !== 0 &&
      sourceStat.ino !== 0 &&
      targetStat.ino === sourceStat.ino &&
      targetStat.dev === sourceStat.dev
    ) {
      return true;
    }
  } catch {
    /* fall through to content check */
  }
  const content = readHookTarget();
  return content !== null && content.includes(MARKER);
}

/** Strategy 1: point core.hooksPath at scripts/guard. */
function installViaHooksPath() {
  // git needs the hook named `pre-push` inside hooksPath; `.mjs` is not
  // executable as a hook on POSIX, so provide an extensionless shim next to
  // the real script and keep the shim in sync on every install.
  const shimPath = join(GUARD_DIR, 'pre-push');
  const shim = [
    '#!/usr/bin/env node',
    `// Extensionless launcher generated by install.mjs - executes pre-push.mjs.`,
    `import { fileURLToPath } from 'node:url';`,
    `const real = new URL('./pre-push.mjs', import.meta.url);`,
    `await import(real.href);`,
    ''
  ].join('\n');
  writeFileSync(shimPath, shim, 'utf8');

  const result = git(['config', HOOKS_PATH_KEY, 'scripts/guard']);
  if (result.code !== 0) {
    log(`${RED}git config ${HOOKS_PATH_KEY} failed: ${result.stderr}${RESET}`);
    return false;
  }
  log(`${GREEN}✔ Installed via ${HOOKS_PATH_KEY}=scripts/guard${RESET}`);
  log('  All hooks now resolve from scripts/guard; pre-push.mjs is active.');
  log('  This survives re-clones only after re-running this installer once.');
  return true;
}

/** Strategy 2: copy the hook into .git/hooks/pre-push. */
function installViaCopy() {
  mkdirSync(HOOKS_DIR_DEFAULT, { recursive: true });

  const existing = readHookTarget();
  if (existing !== null && !existing.includes(MARKER) && existing.trim() !== '') {
    log(`${RED}✖ ${HOOK_TARGET} exists and was not installed by this script.${RESET}`);
    log('  Refusing to overwrite a foreign hook. Merge it manually, then re-run.');
    return false;
  }

  const banner = [
    '#!/usr/bin/env node',
    `// ${MARKER} — safe to delete/reinstall via: node scripts/guard/install.mjs --remove`,
    `// Source of truth: scripts/guard/pre-push.mjs (re-run installer after edits!)`,
    ''
  ].join('\n');
  const source = readFileSync(HOOK_SOURCE, 'utf8');
  writeFileSync(HOOK_TARGET, banner + source, 'utf8');

  // Best effort exec bit; meaningless on Windows, required on POSIX.
  try {
    chmodSync(HOOK_TARGET, 0o755);
  } catch {
    /* Windows: no-op */
  }

  log(`${GREEN}✔ Installed hook copy at .git/hooks/pre-push${RESET}`);
  log('  NOTE: a copy does NOT auto-update; re-run this installer after editing');
  log('  scripts/guard/pre-push.mjs. Prefer the default core.hooksPath strategy.');
  return true;
}

/** --status implementation. */
function showStatus() {
  const hooksPath = getHooksPath();
  log(`repo root:        ${REPO_ROOT}`);
  log(`${HOOKS_PATH_KEY}: ${hooksPath ? hooksPath : '(unset)'}`);

  if (hooksPath) {
    if (isGuardDir(resolve(REPO_ROOT, hooksPath))) {
      log(`${GREEN}guard: ACTIVE (via ${HOOKS_PATH_KEY})${RESET}`);
    } else {
      log(`${RED}guard: INACTIVE — ${HOOKS_PATH_KEY} points somewhere without pre-push.mjs${RESET}`);
    }
  }

  log(`hook copy:        ${isCopyInstalled() ? `${HOOK_TARGET} (present)` : '(none)'}`);
  if (!hooksPath && !isCopyInstalled()) {
    log(`${YELLOW}guard: NOT INSTALLED — run: node scripts/guard/install.mjs${RESET}`);
  }
}

/** --remove implementation. */
function remove() {
  let changed = false;

  const hooksPath = getHooksPath();
  if (hooksPath) {
    const result = git(['config', '--unset', HOOKS_PATH_KEY]);
    if (result.code === 0) {
      log(`${GREEN}✔ unset ${HOOKS_PATH_KEY}${RESET}`);
      changed = true;
    } else {
      log(`${YELLOW}could not unset ${HOOKS_PATH_KEY}: ${result.stderr}${RESET}`);
    }
  }

  if (isCopyInstalled()) {
    rmSync(HOOK_TARGET, { force: true });
    log(`${GREEN}✔ removed ${HOOK_TARGET}${RESET}`);
    changed = true;
  }

  if (!changed) log('Nothing to remove — guard was not installed.');
  return true;
}

function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help) usage(0);

  if (!existsSync(HOOK_SOURCE)) {
    log(`${RED}✖ missing ${HOOK_SOURCE} — repository is incomplete${RESET}`);
    process.exit(1);
  }
  if (git(['rev-parse', '--git-dir']).code !== 0) {
    log(`${RED}✖ not a git repository (run from inside the repo)${RESET}`);
    process.exit(1);
  }

  if (flags.status) {
    showStatus();
    process.exit(0);
  }
  if (flags.remove) {
    process.exit(remove() ? 0 : 1);
  }

  if (flags.copy) {
    process.exit(installViaCopy() ? 0 : 1);
  }

  // Default: prefer hooksPath; fall back to a copy when git config fails
  // (e.g. config locked by a concurrent git process or restricted env).
  if (installViaHooksPath()) process.exit(0);

  log(`${YELLOW}falling back to file-copy strategy…${RESET}`);
  process.exit(installViaCopy() ? 0 : 1);
}

main();
