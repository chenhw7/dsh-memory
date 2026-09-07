/** The web app. Type-check from inside this package with
 * `tsc -p tsconfig.json` — a bare `tsc` from anywhere else takes the
 * repository root as the entry and floods the output with unrelated
 * errors from the other packages. */
export function pageTitle(id: string): string {
  return `page-${id}`
}
