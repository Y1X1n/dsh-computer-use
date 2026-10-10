process.stdout.write(JSON.stringify({ ready: true, version: 'echo', platform: 'win32' }) + '\n')
let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let i
  while ((i = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, i).trim()
    buffer = buffer.slice(i + 1)
    if (!line) continue
    const req = JSON.parse(line)
    process.stdout.write(JSON.stringify({ id: req.id, ok: false, error: { code: 'UNKNOWN_OP', message: 'nope' } }) + '\n')
  }
})