# demo-monorepo

A pnpm workspace: `packages/core` builds first, `packages/web` links against
its emitted `dist`. Build from the root with `pnpm build` (the script runs
the packages in order); type-check one package from inside it with
`tsc -p tsconfig.json`.
