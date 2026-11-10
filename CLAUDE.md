# Bee: notes for agents

## Testing

Runner: Vitest. `npm test` runs `src/**/*.test.ts`, `test/latency.test.ts`, `test/replay-fixtures.test.ts`, `relay/**/*.test.ts` and `scripts/**/*.test.mjs`.

Rules:

- **Default: do not add a test.** Add one only when it guards behaviour that can break and that nothing else covers.
- **A test must call real code.** Import the function or module, give it input, assert on the output or the effect.
- **Never read or regex source files in tests.** No `readFileSync` on `.ts`, `.tsx`, `.css`, `.html`, `.cpp` or `.swift`, and no `?raw` imports. Fixtures, temp dirs, `package.json`, WAVs and PNGs are fine. `npm run lint` enforces this (`scripts/no-source-text-in-tests.mjs`).
- **A regression test must fail on the old code and must run in CI.** Check that it fails with the fix reverted. Keep it in a suite that `npm test` runs.

## Before a PR

Run `npm run preflight` (typecheck, lint, tests) before you push. CI runs the same checks on Ubuntu, plus Windows and macOS builds.

## Commits

Do not add `Co-authored-by: Cursor` trailers to commits.
