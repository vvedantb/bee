# Agents

Follow [CLAUDE.md](CLAUDE.md). In short:

- Before every push, run `npm run preflight` (typecheck, lint, tests: what the Husky pre-push hook runs) and fix any failures. Never skip with `--no-verify`.
- Testing: do not add a test by default. A test must call real code. Never read or regex source files in tests. A regression test must fail on the old code and must run in the suite that `npm test` (and so preflight) runs.
- Do not add `Co-authored-by: Cursor` to commits.
