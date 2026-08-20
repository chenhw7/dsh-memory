/**
 * Post-build step: rewrite `.ts` import specifiers to `.js` in the compiled
 * lib/ output, and copy hand-written typert.remote-client artifacts that tsc
 * does not generate (the Typert codegen normally produces these, but
 * dsh-memory is an external sibling, not in the host workspace build pipeline).
 */
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(full)
    } else if (entry.name.endsWith('.js')) {
      let content = fs.readFileSync(full, 'utf8')
      // Rewrite `from '...something.ts'` to `from '...something.js'`
      content = content.replace(/from(['"])([^'"]+)\.ts(['"])/g, "from$1$2.js$3")
      fs.writeFileSync(full, content)
    }
  }
}

// Fix .ts imports in all compiled .js files
walk(path.join(root, 'lib'))

// Copy hand-written typert.remote-client artifacts to lib/remote/
const remoteDir = path.join(root, 'lib', 'remote')
if (!fs.existsSync(remoteDir)) fs.mkdirSync(remoteDir, { recursive: true })
for (const f of ['typert.remote-client.js', 'typert.remote-client.d.ts']) {
  const src = path.join(root, 'src', f)
  const dst = path.join(remoteDir, f)
  if (fs.existsSync(src)) fs.copyFileSync(src, dst)
}
