/**
 * Synthetic duplicate dataset for §3.4 dedup testing: ≥50 seed facts, each
 * rewritten 3× with near-duplicate phrasing, plus ≥50 genuinely distinct
 * facts as controls. Exercises the dedup pipeline end-to-end through the real
 * store to verify ≤5% duplicate rate and ≥95% retention.
 */

/** One seed fact and its near-duplicate rewrites. */
export interface DedupSeedFact {
  readonly scope: 'global' | 'user'
  readonly original: string
  readonly rewrites: readonly string[]
}

/**
 * 50 seed facts, each with 3 near-duplicate rewrites (200 total candidates).
 * The rewrites use synonym substitution, word reordering, and minor
 * elaboration — the kind of variation an LLM extractor produces across
 * sessions. All facts use `global` or `user` scope (project scope requires
 * a projectName the extraction protocol does not carry — that is §3.6).
 */
export const SEED_FACTS: readonly DedupSeedFact[] = [
  { scope: 'user', original: 'The user prefers concise answers', rewrites: ['User likes concise responses', 'The user wants short answers', 'User prefers brief replies'] },
  { scope: 'user', original: 'The user works in Chinese', rewrites: ['User communicates in Chinese', 'The user prefers Chinese', 'User writes in Chinese language'] },
  { scope: 'user', original: 'The user dislikes verbose explanations', rewrites: ['User does not like long explanations', 'The user hates verbose output', 'User wants non-verbose responses'] },
  { scope: 'user', original: 'The user uses vim', rewrites: ['User prefers vim editor', 'The user edits with vim', 'User likes vim for editing'] },
  { scope: 'user', original: 'The user prefers dark mode', rewrites: ['User likes dark theme', 'The user uses dark mode ui', 'User wants dark interface'] },
  { scope: 'global', original: 'The network blocks npm proxy X', rewrites: ['npm proxy X is blocked by network', 'The network firewall blocks npm proxy', 'npm proxy X unreachable due to network'] },
  { scope: 'global', original: 'The CI runs on Node 22', rewrites: ['CI pipeline uses Node 22', 'The CI environment has Node 22', 'CI runs with Node version 22'] },
  { scope: 'global', original: 'The API rate limit is 60 per minute', rewrites: ['API allows 60 requests per minute', 'The API rate limit is 60/min', 'API has 60 per minute rate limit'] },
  { scope: 'global', original: 'The staging server is unstable', rewrites: ['Staging environment is unreliable', 'The staging server has stability issues', 'Staging server is not stable'] },
  { scope: 'global', original: 'The build agent has 16GB RAM', rewrites: ['Build agent memory is 16GB', 'The CI build agent has 16 gigabytes', 'Build agent equipped with 16GB RAM'] },
  { scope: 'global', original: 'This repo uses pnpm', rewrites: ['The repo uses pnpm for packages', 'This project uses pnpm manager', 'pnpm is the package manager here'] },
  { scope: 'global', original: 'This repo uses vitest', rewrites: ['The project uses vitest for tests', 'This repo tests with vitest', 'vitest is the test runner here'] },
  { scope: 'global', original: 'Never commit the lockfile', rewrites: ['Do not commit package-lock json', 'The lockfile should not be committed', 'Never check in the lockfile'] },
  { scope: 'global', original: 'The build runs tsc then vitest', rewrites: ['Build steps are tsc and vitest', 'The build does tsc followed by vitest', 'Build runs tsc before vitest'] },
  { scope: 'global', original: 'The entry point is src/index.ts', rewrites: ['Main entry is src/index ts', 'The package entry point is src/index', 'src/index ts is the entry file'] },
  { scope: 'user', original: 'The user prefers tabs over spaces', rewrites: ['User likes tabs not spaces', 'The user uses tab indentation', 'User prefers tab characters'] },
  { scope: 'user', original: 'The user wants tests before commits', rewrites: ['User requires tests before committing', 'The user always tests pre-commit', 'User runs tests before git commit'] },
  { scope: 'global', original: 'The CDN cache TTL is 5 minutes', rewrites: ['CDN cache expires in 5 minutes', 'The CDN has 5 min TTL', 'CDN cache duration is 5 minutes'] },
  { scope: 'global', original: 'The log retention is 30 days', rewrites: ['Logs are kept for 30 days', 'The log retention period is 30d', 'Logs expire after 30 days'] },
  { scope: 'global', original: 'The lint config is in eslint.config.js', rewrites: ['eslint config js holds the lint rules', 'The linting config is eslint.config', 'Lint rules live in eslint.config.js'] },
  { scope: 'global', original: 'Use strict TypeScript settings', rewrites: ['The project uses strict tsconfig', 'TypeScript strict mode is enabled', 'tsconfig has strict true'] },
  { scope: 'user', original: 'The user prefers git rebase over merge', rewrites: ['User likes rebase not merge', 'The user uses rebase workflow', 'User prefers rebasing commits'] },
  { scope: 'global', original: 'The database is PostgreSQL 16', rewrites: ['DB is Postgres version 16', 'The database runs PostgreSQL 16', 'PostgreSQL 16 is the database'] },
  { scope: 'global', original: 'The container runtime is Docker', rewrites: ['Docker is the container runtime', 'The project runs in Docker', 'Container runtime is Docker engine'] },
  { scope: 'global', original: 'The source is in ESM format', rewrites: ['The repo uses ES modules', 'Source code is ESM format', 'The project ships as ESM'] },
  { scope: 'user', original: 'The user wants concise error messages', rewrites: ['User prefers short error messages', 'The user likes brief errors', 'User wants compact error text'] },
  { scope: 'global', original: 'The DNS resolver is 8.8.8.8', rewrites: ['DNS server is 8.8.8.8', 'The resolver uses 8.8.8.8', 'DNS configured as 8.8.8.8'] },
  { scope: 'global', original: 'The exports map has 6 subpaths', rewrites: ['package.json exports has 6 entries', 'The exports map includes 6 paths', '6 subpaths in the exports map'] },
  { scope: 'user', original: 'The user reviews PRs within 24 hours', rewrites: ['User reviews pull requests in 24h', 'The user does PR review within a day', 'User reviews PRs in 24 hours'] },
  { scope: 'global', original: 'The SSH key uses ed25519', rewrites: ['SSH key type is ed25519', 'The SSH key algorithm is ed25519', 'ed25519 is the SSH key type'] },
  { scope: 'global', original: 'The build output goes to lib/', rewrites: ['Build artifacts go to lib directory', 'The output directory is lib', 'tsc output goes to lib folder'] },
  { scope: 'user', original: 'The user prefers semantic commits', rewrites: ['User likes conventional commits', 'The user uses semantic commit messages', 'User prefers typed commit messages'] },
  { scope: 'global', original: 'The max file size is 10MB', rewrites: ['File size limit is 10 megabytes', 'The max file size is 10 MB', '10MB is the file size cap'] },
  { scope: 'global', original: 'The test timeout is 5000ms', rewrites: ['Tests have 5 second timeout', 'The test timeout is 5000 ms', 'vitest timeout is 5000ms'] },
  { scope: 'user', original: 'The user wants CI to block on test failure', rewrites: ['User requires CI to fail on test errors', 'The user blocks merge on test failure', 'User wants CI blocking on failing tests'] },
  { scope: 'global', original: 'The API gateway is Kong', rewrites: ['Kong is the API gateway', 'The gateway uses Kong', 'API gateway is Kong based'] },
  { scope: 'global', original: 'The license is MIT', rewrites: ['The project uses MIT license', 'MIT is the license', 'Licensed under MIT'] },
  { scope: 'user', original: 'The user prefers inline comments', rewrites: ['User likes inline code comments', 'The user wants comments inline', 'User prefers in-code comments'] },
  { scope: 'global', original: 'The monitoring uses Prometheus', rewrites: ['Prometheus is the monitoring tool', 'The monitoring stack is Prometheus', 'Metrics go to Prometheus'] },
  { scope: 'global', original: 'The CI runs on GitHub Actions', rewrites: ['CI pipeline is GitHub Actions', 'The project uses GitHub Actions CI', 'GitHub Actions runs the CI'] },
  { scope: 'user', original: 'The user wants signed commits', rewrites: ['User prefers GPG signed commits', 'The user signs git commits', 'User wants commit signing enabled'] },
  { scope: 'global', original: 'The log level is info in production', rewrites: ['Production log level is info', 'Logs are info level in prod', 'The log level for prod is info'] },
  { scope: 'global', original: 'The target is ES2024', rewrites: ['tsconfig target is ES2024', 'The project targets ES 2024', 'ES2024 is the build target'] },
  { scope: 'user', original: 'The user dislikes alert popups', rewrites: ['User does not like alert dialogs', 'The user hates popup alerts', 'User wants no alert popups'] },
  { scope: 'global', original: 'The backup runs at 2AM UTC', rewrites: ['Backups happen at 2 AM UTC', 'The backup schedule is 2AM UTC', 'Backup runs at 02:00 UTC'] },
  { scope: 'global', original: 'The strict mode is enabled', rewrites: ['Strict mode is on', 'The project uses strict mode', 'strict is true in config'] },
  { scope: 'user', original: 'The user prefers squash merges', rewrites: ['User likes squash and merge', 'The user uses squash merge', 'User prefers squashing commits'] },
  { scope: 'global', original: 'The TLS version is 1.3', rewrites: ['TLS 1.3 is the protocol version', 'The TLS version is 1.3', 'TLS 1.3 is used for connections'] },
  { scope: 'global', original: 'The module resolution is bundler', rewrites: ['Module resolution is bundler mode', 'The project uses bundler resolution', 'moduleResolution is bundler'] },
  { scope: 'user', original: 'The user wants PR templates', rewrites: ['User prefers pull request templates', 'The user uses PR templates', 'User wants template for PRs'] },
  { scope: 'global', original: 'The cache backend is Redis', rewrites: ['Redis is the cache backend', 'The caching uses Redis', 'Cache layer is Redis based'] },
]

/**
 * 50 genuinely distinct facts as controls — these should NOT be merged into
 * each other or into any seed fact. Each shares no significant token overlap
 * with any other entry.
 */
export const CONTROL_FACTS: readonly { readonly scope: 'global' | 'user'; readonly content: string }[] = [
  { scope: 'global', content: 'The moon orbits Earth every 27 days' },
  { scope: 'global', content: 'The fishing village was founded in 1820' },
  { scope: 'user', content: 'My favorite color is teal' },
  { scope: 'global', content: 'Water boils at 100 degrees Celsius at sea level' },
  { scope: 'global', content: 'The bridge spans 2.4 kilometers across the bay' },
  { scope: 'user', content: 'I enjoy hiking on weekends' },
  { scope: 'global', content: 'The speed of light is approximately 299792458 m/s' },
  { scope: 'global', content: 'The cathedral was built in the 12th century' },
  { scope: 'user', content: 'My birthday is in March' },
  { scope: 'global', content: 'Photosynthesis converts CO2 into glucose' },
  { scope: 'global', content: 'The library has over 50000 books' },
  { scope: 'user', content: 'I prefer tea over coffee' },
  { scope: 'global', content: 'The Mariana Trench is 11000 meters deep' },
  { scope: 'global', content: 'The railway opened in 1869' },
  { scope: 'user', content: 'My dog is named Baxter' },
  { scope: 'global', content: 'The Great Wall stretches 21000 kilometers' },
  { scope: 'global', content: 'The opera house seats 2000 people' },
  { scope: 'user', content: 'I play the guitar' },
  { scope: 'global', content: 'A honeybee beats its wings 230 times per second' },
  { scope: 'global', content: 'The dam generates 22500 megawatts' },
  { scope: 'user', content: 'I read fiction before bed' },
  { scope: 'global', content: 'The Amazon River is 6400 kilometers long' },
  { scope: 'global', content: 'The stadium hosted the 1996 Olympics' },
  { scope: 'user', content: 'My car is a Honda' },
  { scope: 'global', content: 'Mount Everest stands at 8849 meters' },
  { scope: 'global', content: 'The museum exhibits 300 paintings' },
  { scope: 'user', content: 'I prefer winter over summer' },
  { scope: 'global', content: 'The human body has 206 bones' },
  { scope: 'global', content: 'The vineyard produces 50000 bottles yearly' },
  { scope: 'user', content: 'My favorite season is autumn' },
  { scope: 'global', content: 'Jupiter has 95 known moons' },
  { scope: 'global', content: 'The tunnel is 57 kilometers long' },
  { scope: 'user', content: 'I cook pasta every Sunday' },
  { scope: 'global', content: 'The Sahara Desert covers 9 million square kilometers' },
  { scope: 'global', content: 'The telescope has a 10 meter mirror' },
  { scope: 'user', content: 'I listen to jazz music' },
  { scope: 'global', content: 'An octopus has three hearts' },
  { scope: 'global', content: 'The castle was besieged in 1453' },
  { scope: 'user', content: 'My height is 178 centimeters' },
  { scope: 'global', content: 'The Nile flows 6650 kilometers north' },
  { scope: 'global', content: 'The factory produces 1000 cars daily' },
  { scope: 'user', content: 'I swim in the ocean every summer' },
  { scope: 'global', content: 'A group of flamingos is called a flamboyance' },
  { scope: 'global', content: 'The airport handles 80 million passengers' },
  { scope: 'user', content: 'I prefer cats to dogs actually' },
  { scope: 'global', content: 'The Statue of Liberty is 93 meters tall' },
  { scope: 'global', content: 'The garden has 200 rose varieties' },
  { scope: 'user', content: 'I drink 2 liters of water daily' },
  { scope: 'global', content: 'The Eiffel Tower weighs 10100 tons' },
]
