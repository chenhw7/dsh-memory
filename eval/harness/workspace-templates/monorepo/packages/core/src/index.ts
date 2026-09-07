/** The shared core module. Building it first matters: packages/web builds
 * against this package's emitted dist, and a stale dist links the web app
 * to yesterday's core. */
export function coreVersion(): string {
  return '0.1.0'
}
