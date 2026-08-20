# Lessons: Developing dsh Plugin Client UI

Lessons from the dsh-memory plugin's UI consistency debugging, distilled for
anyone building a dsh plugin that contributes a settings card or browser-side UI.

---

## 1. The host does not export UI components as runtime values

`@deepseek-ai/dsh-client-ui-settings-plugins` builds `PluginCard`, `ValueField`,
`CardForm`, and `numberField`/`textField` as **internal module-scope symbols**.
The package's `exports["./client"]` ships only `apply` and `inject`. The
`export type { PluginCardProps }` declarations in `index.ts` are type-only — they
exist for cross-package type-checking, not for runtime import.

You **cannot** `import { PluginCard } from '@deepseek-ai/dsh-client-ui-settings-plugins/client'`.
The npm package doesn't ship `src/`, so the `"./src/*": "./src/*"` export is a
dead path. The built `lib/client.js` wraps everything in a
`window.__ModuleLoader__.load({ factory })` closure — the components are local
variables, unreachable from outside.

**Implication:** every external plugin that contributes a settings card must
replicate the card shell, field controls, and CSS from scratch. Keep your copy
in sync with the host source; treat the host's `PluginCard.module.css` and
`fields.module.css` as the source of truth.

---

## 2. esbuild CJS compilation turns `const` into `var` — TDZ protection vanishes

When the client bundle is built with esbuild in `format: 'cjs'`, every
module-level `const` becomes `var`. `var` declarations are **hoisted** to the top
of the module, but their **assignments are not**. This means:

```js
// Source (TypeScript, protected by TDZ):
const css = (inject(), cls)   // inject() references RULES below
const RULES = `...`            // TDZ would throw at inject() time

// Compiled (CJS, no TDZ):
var css = (inject(), cls)      // inject() runs NOW — RULES is undefined
var RULES = `...`             // assigned AFTER inject() already ran
```

`inject()` sets `style.textContent = RULES` — but `RULES` is `undefined`, so the
`<style>` tag is empty. **CSS is silently never injected.** The card renders with
browser defaults, looking nothing like the host cards. No error is thrown.

**Rule:** when using esbuild CJS output, any value referenced by a module-level
side effect (like `inject()`) must be **defined above** the side-effect call.
Don't rely on `const` TDZ to catch ordering mistakes — the compilation step
removes that safety net.

---

## 3. CSS property parity is not enough — verify CSS is actually injected

During debugging, it's tempting to focus on CSS property differences
(`width: 100%` vs absent, `composes` vs manual expansion). Those matter for
visual fidelity, but if the user reports "the entire card looks wrong," the CSS
is probably **not injected at all** — a much stronger signal than property
mismatches.

**Debugging checklist:**
1. Open DevTools → Elements → `<head>`. Is there a `<style>` tag with your
   plugin's `data-*` attribute?
2. Is its `textContent` empty or populated?
3. In the built `lib/client/index.js`, search for the variable that holds the
   CSS string and the function that injects it. Which comes first in the file?

---

## 4. dsh client bundle loading chain — what happens after `npm run build`

The `dsh web` server loads plugin client bundles through a specific chain.
Understanding it is essential for debugging "my change doesn't show up":

1. **Startup scan:** `ClientModuleRegistry` scans all composed entries for
   `dsh.client` declarations. For each, it reads `package.json` →
   `exports["./client"]` → resolves `lib/client/index.js` (or whatever the
   export points to).
2. **Revision hash:** the file content is SHA1-hashed (12 hex chars) at
   **startup**. This `rev` is injected into the HTML as
   `window.__DSH_BOOT__` — the browser loads
   `/plugins/<id>/client.js?rev=<hash>`.
3. **Runtime serving:** each request is read **live from disk** (`readFile`)
   with `cache-control: no-cache`. The server does not cache file content.
4. **Rev is fixed for the process lifetime.** If you rebuild the bundle while
   `dsh web` is running, the file on disk changes, but the `rev` in
   `window.__DSH_BOOT__` stays the old hash. The browser URL doesn't change, so
   the browser may serve a cached response.

**Correct test loop after editing plugin client code:**

```
npm run build          # rebuild lib/client/index.js
# restart dsh web      # recompute rev → new URL → browser fetches new file
# hard-refresh browser  # Ctrl+Shift+R — bypass browser cache
```

For `file:` installs (symlink), no reinstall is needed — the symlink points to
your working tree. For npm installs, you must republish or reinstall.

---

## 5. CSS Modules `composes` cannot be naively replicated

The host uses CSS Modules with `composes: input` in `.inputInvalid`:
```css
.inputInvalid {
  composes: input;
  border-color: var(--dsw-alias-label-error);
}
```

`composes` merges all properties of `input` into `inputInvalid`, then overrides
`border-color`. Since external plugins can't use CSS Modules (no host build
pipeline), you must **manually expand** the composed properties:

```css
.dsm-c-input-invalid {
  /* copy every property from .dsm-c-input */
  height: 34px;
  padding: 0 12px;
  border: 1px solid var(--dsw-alias-label-error);  /* overridden */
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-3);
  font: inherit;
  font-size: 13px;
  line-height: 1.5;
  color: var(--dsw-alias-label-primary);
}
```

When the host updates `.input`, your manual expansion won't follow. Track the
host source as the source of truth and re-sync on dependency bumps.

---

## 6. Match the host's `available` / `writable` semantics, not just CSS

The host `PluginCard` renders `null` when `state.available === false`, where
`available = snapshot.status === 'ready'`. A plugin that checks
`status === 'unavailable'` instead will render the card during `loading` state —
the host wouldn't. This produces a visible flash and inconsistent behavior.

**Rule:** read the host component source to understand the exact status
transitions, and mirror them precisely. CSS parity without behavioral parity
still looks wrong.
