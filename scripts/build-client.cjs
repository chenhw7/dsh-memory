/**
 * Build the memory client bundle as a closure-factory JS artifact matching
 * the host's `window.__ModuleLoader__.load({id, factory})` format.
 *
 * External dependencies (react, host client packages) are resolved through
 * the injected `require` — they are NOT bundled. Only our own source
 * (src/client/*.tsx) is compiled into the factory body.
 *
 * Output: lib/client/index.js
 */

const esbuild = require('esbuild')
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')

// All imports from host packages or react are externals — resolved at runtime
// by the module loader's require(). We map them to valid require() identifiers.
const externals = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-locale/client',
  '@deepseek-ai/dsh-api-remotes/client',
  '@deepseek-ai/dsh-client-ui-settings/client',
  '@deepseek-ai/dsh-client-ui-settings-plugins/client',
]

async function build() {
  const result = await esbuild.build({
    entryPoints: [path.join(root, 'src', 'client', 'index.ts')],
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    jsx: 'automatic',
    external: externals,
    write: false,
    minify: false,
    sourcemap: false,
  })

  // Wrap in the module loader factory format
  const code = result.outputFiles[0].text

  // esbuild outputs `var require_xxx = __commonJS(...)` blocks for externals.
  // We need to replace those with `require("...")` calls that the factory's
  // injected `require` parameter resolves.
  // The simplest approach: wrap the raw output in the factory.

  const bundle = `window.__ModuleLoader__.load({
  id: "@chenhw7/dsh-memory",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    // Map external require calls to the factory's injected require
    ${code
      .replace(/require\(["']react\/jsx-runtime["']\)/g, 'require("react/jsx-runtime")')
      .replace(/require\(["']react["']\)/g, 'require("react")')
      .replace(/require\(["']react-dom["']\)/g, 'require("react-dom")')
      .replace(/require\(["']react-dom\/client["']\)/g, 'require("react-dom/client")')
    }

    return module.exports;
  }
});
`

  const outDir = path.join(root, 'lib', 'client')
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(path.join(outDir, 'index.js'), bundle, 'utf8')
  console.log('Built client bundle: lib/client/index.js')
}

build().catch(err => {
  console.error('Client build failed:', err)
  process.exit(1)
})
