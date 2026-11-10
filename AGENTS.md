# Agents

Follow [CLAUDE.md](CLAUDE.md). In short:

- Run `npm run preflight` (typecheck, lint, tests) before you push.
- Testing: do not add a test by default. A test must call real code. Never read or regex source files in tests. A regression test must fail on the old code and must run in CI.
- Do not add `Co-authored-by: Cursor` to commits.
