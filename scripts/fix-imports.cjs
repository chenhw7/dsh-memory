/**
 * Post-build step: rewrite `.ts` import specifiers to `.js` in the compiled
 * lib/ output, copy hand-written typert.remote-client artifacts that tsc does
 * not generate (the Typert codegen normally produces these, but dsh-memory is
 * an external sibling, not in the host workspace build pipeline), and stamp
 * one package identity per composed loader row.
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

// One package identity per composed loader row. The host's client-module
// scanner maps every active Loader row to its nearest package.json and refuses
// a package that several rows resolve to ("multiple active Loader sources");
// without these stamps each row would resolve to this package root and the
// bundle's client half would never compose. The names are scanner identities,
// not publishable packages; only the root row carries `dsh.client`.
const rowPackages = {
  store: '@chenhw7/dsh-memory-store',
  tool: '@chenhw7/dsh-memory-tool',
  review: '@chenhw7/dsh-memory-review',
  notes: '@chenhw7/dsh-memory-notes',
  identity: '@chenhw7/dsh-memory-identity',
  context: '@chenhw7/dsh-memory-context',
  remote: '@chenhw7/dsh-memory-remote-service',
}
for (const [dir, name] of Object.entries(rowPackages)) {
  const target = path.join(root, 'lib', dir)
  if (!fs.existsSync(target)) continue
  fs.writeFileSync(
    path.join(target, 'package.json'),
    `${JSON.stringify({ name, type: 'module' }, null, 2)}\n`,
  )
}
