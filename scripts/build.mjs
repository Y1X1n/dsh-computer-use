import { build } from 'esbuild'
import { cp, mkdir, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'

await mkdir('lib', { recursive: true })

// Host half: ESM. @deepseek-ai/* and node builtins stay external — resolved by
// the profile's node_modules at runtime.
await build({
  entryPoints: ['src/index.ts'],
  outfile: 'lib/index.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  packages: 'external',
  logLevel: 'info',
})

// Bridge client as a standalone entry so tests can import it without the host.
await build({
  entryPoints: ['src/bridge/client.ts'],
  outfile: 'lib/bridge/client.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  packages: 'external',
  logLevel: 'info',
})

// Tool modules as standalone entries for the same reason: tests exercise the
// argument-mapping logic without a dsh host.
const toolEntries = {
  'lib/tools/screenshot.js': 'src/tools/screenshot.ts',
  'lib/tools/input.js': 'src/tools/input.ts',
  'lib/tools/windows.js': 'src/tools/windows.ts',
  'lib/tools/ui.js': 'src/tools/ui.ts',
  'lib/tools/wait.js': 'src/tools/wait.ts',
  'lib/types.js': 'src/types.ts',
}
for (const [outfile, entryPoint] of Object.entries(toolEntries)) {
  await build({
    entryPoints: [entryPoint],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    packages: 'external',
    logLevel: 'silent',
  })
}

// The PowerShell bridge ships verbatim next to the bundle.
if (existsSync('bridge')) {
  await cp('bridge', 'lib/../bridge', { recursive: true, force: true }).catch(() => undefined)
}

const pkg = JSON.parse(await readFile('package.json', 'utf8'))
console.log(`[build] ${pkg.name}@${pkg.version} -> lib/index.js + lib/bridge/client.js`)
