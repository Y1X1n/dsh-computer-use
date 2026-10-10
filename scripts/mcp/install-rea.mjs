// Register the REA MCP server (https://github.com/morluto/rea) into the DSH
// desktop profile's cordis patch. Idempotent.
//
// The desktop profile patch is a top-level YAML array whose entries are either
// id-targeted overrides ({id, name, config}) or insert lists ({insert: [...]}).
// This script appends a dedicated insert entry — the same shape dsh-base uses —
// so it never has to rewrite an existing override row.
//
// Usage:  node scripts/mcp/install-rea.mjs
// Requires the DSH desktop profile at %USERPROFILE%\.dsh\profiles\desktop.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const PROFILE = join(homedir(), '.dsh', 'profiles', 'desktop')
const PATCH = join(PROFILE, 'cordis.patch.yml')

const ROW_ID = 'mcp-rea'
const SERVER_NAME = 'rea'
const HEADER = `# REA MCP server (github.com/morluto/rea) installed by dsh-computer-use.`

function readReaVersion() {
  const probe = spawnSync(process.platform === 'win32' ? 'rea.cmd' : 'rea', ['--version'], {
    encoding: 'utf8',
    shell: true,
  })
  const version = (probe.stdout || '').trim().match(/\d+\.\d+\.\d+/)?.[0]
  return version ?? null
}

function buildEntry(version) {
  // Pin to the version that performed setup, exactly as rea's own setup does.
  const args = version ? ['-y', `rea-agents@${version}`, 'mcp'] : ['-y', 'rea-agents@latest', 'mcp']
  return [
    HEADER,
    'Tools surface as mcp__rea__<tool>. Reload/restart the profile to connect.',
    '- insert:',
    `    - id: ${ROW_ID}`,
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '      config:',
    `        serverName: ${SERVER_NAME}`,
    '        transport: stdio',
    '        command: npx',
    `        args: [${args.map((a) => `'${a}'`).join(', ')}]`,
    '        toolCallTimeoutMs: 120000',
    '        failOnStartupError: false',
  ].join('\n')
}

if (!existsSync(PATCH)) {
  console.error(`[mcp] DSH desktop profile patch not found: ${PATCH}`)
  console.error('[mcp] Launch DSH desktop once, then re-run this script.')
  process.exit(1)
}

const raw = readFileSync(PATCH, 'utf8')
const version = readReaVersion()
const rowRe = new RegExp(`^\\s*- id: ${ROW_ID}$`, 'm')

if (rowRe.test(raw)) {
  console.log(`[mcp] rea MCP already registered in ${PATCH} (${version ?? 'unpinned'}) — nothing to do.`)
  process.exit(0)
}

const body = raw.endsWith('\n') ? raw : raw + '\n'
const updated = body + '\n' + buildEntry(version) + '\n'
writeFileSync(PATCH, updated)
console.log(`[mcp] rea MCP ${version ?? 'latest'} registered into ${PATCH}`)
console.log('[mcp] Reload plugins or restart the DSH desktop profile to connect.')
console.log('[mcp] Tools will appear as mcp__rea__<tool>.')
