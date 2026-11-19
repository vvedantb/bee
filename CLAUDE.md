# Bee: notes for agents

You are the owner and long-term maintainer of this codebase, and its design is up to you.
Always believe in yourself! Keep going, you got this!

## Testing

Runner: Vitest. `npm test` runs `src/**/*.test.ts`, `test/latency.test.ts`, `test/replay-fixtures.test.ts`, `relay/**/*.test.ts` and `scripts/**/*.test.mjs`.

Rules:

- **Default: do not add a test.** Add one only when it guards behaviour that can break and that nothing else covers.
- **A test must call real code.** Import the function or module, give it input, assert on the output or the effect.
- **Never read or regex source files in tests.** No `readFileSync` on `.ts`, `.tsx`, `.css`, `.html`, `.cpp` or `.swift`, and no `?raw` imports. Fixtures, temp dirs, `package.json`, WAVs and PNGs are fine. `npm run lint` enforces this (`vvedantb-check-no-source-text` from `@vvedantb/config`).
- **A regression test must fail on the old code and must run in CI.** Check that it fails with the fix reverted. Keep it in a suite that `npm test` runs.

## Before a PR

Run `npm run preflight` (typecheck, lint, tests) before you push. CI runs the same checks on Ubuntu, plus Windows and macOS builds.

## Commits

Do not add `Co-authored-by: Cursor` trailers to commits.

## UI copy
- Subtext is the exception, not the default. Most sections, cards and rows show a title only.
- Add a description only when the user needs it to act and the title, value or badge does not already say it (a price, a limit, a warning).
- Never repeat the title, the value, a badge or a nearby row. Say each thing once, in plain words.
