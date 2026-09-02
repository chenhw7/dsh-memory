/**
 * Profile-template materialization for the eval harness boot path.
 *
 * Reads the static templates under `eval/harness/profile-template/`, applies
 * the per-run substitutions, and writes a ready profile directory under
 * `<dshHome>/profiles/<name>/` in the shape the harness profile loader expects
 * (packages/boot/app-boot/src/profile.ts): a package.json with
 * `dsh.profile.bundles`, a user patch layer `cordis.patch.yml`, and a
 * `node_modules/@chenhw7/dsh-memory` symlink so `resolveBundleDir` finds the
 * linked plugin build from the profile anchor (no install step runs here; the
 * harness's own module-fallback heal covers the plugin's dependency closure
 * at boot).
 *
 * Import-safe from vitest: node builtins only, no harness-repo imports.
 *
 * @module eval/harness/profile-template
 */

import { mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Directory holding the static profile templates (this file's sibling). */
export const PROFILE_TEMPLATE_DIR = join(fileURLToPath(new URL('.', import.meta.url)), 'profile-template')

/**
 * The profile bundle list, in layer order: dsh-base, the SDK app, the memory
 * plugin (mirrors PROFILE_TEMPLATES.sdk plus the linked plugin bundle).
 */
export const PROFILE_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-sdk-app', '@chenhw7/dsh-memory'] as const

/** The plugin bundle name the profile links to the build under test. */
export const PLUGIN_BUNDLE_NAME = '@chenhw7/dsh-memory'

/**
 * Model routing mode for one eval run. `external` pins nothing in the
 * settings document: the route is a caller-owned per-scenario endpoint
 * injected through the child env only.
 */
export type ModelMode = 'mock' | 'real' | 'external'

/** Values substituted into the template files for one run. */
export interface TemplateVars {
  /** Model routing mode; selects the settings template. */
  mode: ModelMode
  /** Absolute directory of the plugin build under test (the `link:` target). */
  buildDir: string
  /** Mock server base URL including the `/v1` namespace; required for mock runs. */
  mockBaseUrl?: string
  /**
   * Rendered `llm-pi-ai:` settings section mirroring the deployment's provider
   * profiles into the throwaway home (the same activation the web Models page
   * performs). Required when the model route names a non-DeepSeek provider;
   * absent means the stock deepseek-official adapter stands.
   */
  piAiSection?: string
}

/** The `{{NAME}}` substitution used by the template files. */
function substitute(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{([A-Z0-9_]+)\}\}/g, (whole: string, name: string) => {
    const value = vars[name]
    if (value === undefined) {
      throw new Error(`eval profile template: no substitution provided for ${whole}`)
    }
    return value
  })
}

/** Render the profile package.json body for one build directory. */
export function renderProfilePackageJson(buildDir: string): string {
  const template = readFileSync(join(PROFILE_TEMPLATE_DIR, 'package.json'), 'utf8')
  return substitute(template, { BUILD_DIR: resolve(buildDir) })
}

/**
 * Render the settings document for one run. `external` shares the real-mode
 * document (it pins nothing); a pi-ai provider route replaces the empty real
 * document with the deployment's mirrored `llm-pi-ai:` section — the section
 * is a complete top-level mapping, so it stands alone.
 */
export function renderSettingsYaml(mode: ModelMode, mockBaseUrl: string | undefined, piAiSection?: string): string {
  if (mode !== 'mock' && piAiSection !== undefined && piAiSection.length > 0) {
    return piAiSection.endsWith('\n') ? piAiSection : `${piAiSection}\n`
  }
  const file = mode === 'mock' ? 'settings.mock.yaml' : 'settings.real.yaml'
  const template = readFileSync(join(PROFILE_TEMPLATE_DIR, file), 'utf8')
  return substitute(template, mode === 'mock' ? { MOCK_BASE_URL: mockBaseUrl ?? '' } : {})
}

/** Render the user patch layer (verbatim copy; the pins live in the template). */
export function renderProfilePatchYaml(): string {
  return readFileSync(join(PROFILE_TEMPLATE_DIR, 'cordis.patch.yml'), 'utf8')
}

/**
 * Validate a profile name with the same rules as the harness profile loader
 * (resolveProfileDir rejects separators, dot segments, and `node_modules`).
 */
export function assertValidProfileName(name: string): void {
  if (name === '' || name === '.' || name === '..' || name === 'node_modules'
    || name.includes('/') || name.includes('\\')) {
    throw new Error(`eval profile template: invalid profile name ${JSON.stringify(name)}`)
  }
}

/**
 * Materialize the profile directory for one run. Files are rewritten on every
 * call (the profile directory is throwaway per run, so a stale template copy
 * would silently blur runs), and the plugin symlink is re-pointed at the
 * current build when it drifted. The settings document lands at
 * `<dshHome>/settings.yaml` — the only location the harness settings-file
 * service parses (packages/settings/settings-file/src/index.ts); the profile
 * directory itself is not a settings source.
 * @param dshHome - the throwaway harness home for this run.
 * @param profileName - the profile directory name (`dsh --profile <name>`).
 * @param vars - per-run substitutions (build dir; mock URL for mock mode).
 * @returns the absolute profile directory.
 */
export function materializeProfile(dshHome: string, profileName: string, vars: TemplateVars): string {
  assertValidProfileName(profileName)
  const buildDir = resolve(vars.buildDir)
  if (buildDir.length === 0) {
    throw new Error('eval profile template: buildDir must be a non-empty path')
  }
  if (vars.mode === 'mock' && (vars.mockBaseUrl === undefined || vars.mockBaseUrl.length === 0)) {
    throw new Error('eval profile template: mock runs require a mockBaseUrl')
  }
  if (vars.mode === 'mock' && vars.piAiSection !== undefined) {
    throw new Error('eval profile template: mock runs must not carry an llm-pi-ai section (the mock route is deterministic)')
  }
  const profileDir = resolve(dshHome, 'profiles', profileName)
  mkdirSync(profileDir, { recursive: true })
  const manifest = {
    ...(JSON.parse(renderProfilePackageJson(buildDir)) as Record<string, unknown>),
    // The profile name rides in the manifest name the way the harness's own
    // initProfile names generated profiles (`dsh-profile-<basename>`), keeping
    // throwaway homes distinguishable in diagnostics.
    name: `dsh-profile-${profileName}`,
  }
  writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify(manifest, undefined, 2)}\n`)
  writeFileSync(join(profileDir, 'cordis.patch.yml'), renderProfilePatchYaml())
  writeFileSync(join(dshHome, 'settings.yaml'), renderSettingsYaml(vars.mode, vars.mockBaseUrl, vars.piAiSection))
  const scopedDir = join(profileDir, 'node_modules', '@chenhw7')
  const link = join(scopedDir, 'dsh-memory')
  mkdirSync(scopedDir, { recursive: true })
  try {
    if (readlinkSync(link) === buildDir) return profileDir
    // A drifted link is replaced below; unlink first because symlinkSync never
    // overwrites.
    rmSync(link)
  } catch (error) {
    // ENOENT is the normal first-run path (no link yet); any other readlink
    // failure on a path whose parent we just created resurfaces at symlinkSync.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  symlinkSync(buildDir, link, 'junction')
  return profileDir
}
