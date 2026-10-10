#!/usr/bin/env node
/**
 * pre-push hook — local enforcement layer of the mandatory PR workflow.
 *
 * Git invokes this hook as:
 *   pre-push <remote-name> <remote-url>
 * and feeds one line per pushed ref on stdin:
 *   <local_ref> <local_sha> <remote_ref> <remote_sha>
 *
 * Policy: pushing to refs/heads/main (or refs/heads/master) is rejected.
 * The only escape hatch is the environment variable ALLOW_MAIN_PUSH=1,
 * reserved for legitimate one-off scenarios such as importing history for
 * the first time. Every bypass attempt is logged to scripts/guard/bypass.log
 * so the audit trail survives even a bypassed push.
 *
 * Zero third-party dependencies. Node >= 16.
 */
'use strict';

import { appendFileSync } from 'node:fs';
import { stdin } from 'node:process';

/** Branches that must never receive a direct push. */
const PROTECTED_BRANCHES = new Set(['main', 'master']);
/** Exit code git interprets as "cancel the push". */
const EXIT_DENIED = 1;
/** Exit code git interprets as "push may proceed". */
const EXIT_OK = 0;

const BOLD = '\x1b[1m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

function log(message) {
  process.stderr.write(`${message}\n`);
}

/**
 * Extract the branch name from a fully qualified ref, e.g.
 * refs/heads/main -> main. Returns null for non-branch refs (tags, etc.).
 * @param {string} ref
 * @returns {string | null}
 */
function branchFromRef(ref) {
  const match = /^refs\/heads\/(.+)$/.exec(String(ref || '').trim());
  return match ? match[1] : null;
}

/** @returns {string} local timestamp in ISO-like local format */
function timestamp() {
  return new Date().toISOString();
}

/** @returns {string} best-effort "who/where" line for the audit log */
function contextLine() {
  return `cwd=${process.cwd()} user=${process.env.USERNAME || process.env.USER || 'unknown'}`;
}

/**
 * Append a line to scripts/guard/bypass.log (best effort; a failing log
 * write must never turn a legitimate push into a hard failure).
 */
function auditLog(line) {
  try {
    // process.cwd() during a git hook run is the repo root.
    appendFileSync('scripts/guard/bypass.log', line, 'utf8');
  } catch {
    /* best effort only */
  }
}

/** @returns {Promise<string>} everything git wrote to the hook's stdin */
function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    // Manual invocation (TTY, no piped stdin) would never reach 'end';
    // git always pipes ref lines, so treat a TTY as "no input".
    if (stdin.isTTY) {
      resolve('');
      return;
    }
    stdin.setEncoding('utf8');
    stdin.on('data', (chunk) => {
      data += chunk;
    });
    stdin.on('end', () => resolve(data));
    // Defensive: never hang if 'end' never fires (e.g. piping quirks).
    stdin.on('close', () => resolve(data));
    stdin.resume();
  });
}

async function main() {
  const bypassAllowed = process.env.ALLOW_MAIN_PUSH === '1';
  const input = await readStdin();

  const lines = input.split(/\r?\n/).filter((line) => line.trim() !== '');
  /** @type {string[]} */
  const violations = [];

  for (const line of lines) {
    // Format: <local_ref> <local_sha> <remote_ref> <remote_sha>
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4) continue; // not a ref update line; ignore
    const [localRef, localSha, remoteRef] = parts;

    const branch = branchFromRef(remoteRef);
    if (!branch || !PROTECTED_BRANCHES.has(branch)) continue;

    // Deletion pushes have the all-zero local sha; they are blocked too.
    const isDelete = /^0+$/.test(localSha);

    if (bypassAllowed) {
      const entry = `[bypass] ${timestamp()} branch=${branch} remote_ref=${remoteRef} local_sha=${localSha} ${contextLine()}\n`;
      auditLog(entry);
      log(
        `${YELLOW}${BOLD}[pre-push] WARNING: ALLOW_MAIN_PUSH=1 — bypassing protection for '${branch}'.${RESET}`
      );
      log(
        `${YELLOW}[pre-push] This bypass has been recorded in scripts/guard/bypass.log.${RESET}`
      );
      continue;
    }

    violations.push(
      [
        '',
        `${BOLD}${RED}[pre-push] ✖ Direct push to protected branch '${branch}' is forbidden.${RESET}`,
        `${RED}  ref:        ${remoteRef}${RESET}`,
        `${RED}  local sha:  ${localSha}${RESET}`,
        `${RED}  deletion:   ${isDelete ? 'yes' : 'no'}${RESET}`,
        '',
        '  This repository enforces the mandatory PR workflow:',
        '    1. git checkout -b <feature-branch>   (feat/… fix/… chore/… docs/…)',
        '    2. git push -u origin <feature-branch>',
        '    3. gh pr create (or open a PR on GitHub) and let CI run',
        '    4. merge via the PR — never push straight to main',
        '',
        `  Details: ${BOLD}docs/PR-WORKFLOW.md${RESET}`,
        '  Legitimate bypass (first-time history import only):',
        '    ALLOW_MAIN_PUSH=1 git push origin main   # audited in scripts/guard/bypass.log',
        ''
      ].join('\n')
    );
  }

  if (violations.length > 0) {
    for (const message of violations) log(message);
    log(`${BOLD}${RED}[pre-push] Push rejected. Use a feature branch + PR (see docs/PR-WORKFLOW.md).${RESET}`);
    process.exit(EXIT_DENIED);
  }

  process.exit(EXIT_OK);
}

main().catch((error) => {
  // The guard must never block unrelated work on its own crash — but when in
  // doubt, fail closed: a broken guard should not silently wave pushes through.
  log(`[pre-push] internal error: ${error && error.stack ? error.stack : error}`);
  process.exit(EXIT_DENIED);
});
