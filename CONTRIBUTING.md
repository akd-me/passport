# Contributing to Passport

Thanks for helping build an agent-native email harness.

## Ground rules

- Read `docs/CONTRACT.md` first. It defines the package boundaries and the invariants
  (every state change is a logged Action; sends are held in the outbox; verification never
  comes from message content; external agents are capped by policy).
- Mail is read on demand ([design](docs/design/on-demand.md)). Never add a backfill or a mirror:
  the watcher's cursor starts at connect time, every provider read declares its quota cost and
  goes through the per-account governor, and provider-derived strings in prompts and tool results
  are framed as untrusted data.
- `packages/types` is the contract. Add, don't rename. A change there is a cross-package change.
- No native modules. Node 24 (persistent workspaces need ≥ 22.16 with SQLite FTS5), pnpm 10,
  TypeScript strict, vitest.
- Tests run offline. Use the mock providers and in-memory stores; never hit a live API in tests.
- Never log credentials or full message bodies.

## Workflow

```sh
pnpm install
pnpm build
pnpm typecheck
pnpm lint
pnpm format:check
PASSPORT_SKIP_LIVE_HOST_AGENTS=1 pnpm test
pnpm format                           # apply Biome formatting
pnpm --filter @passport/server demo     # UI on fixture data
pnpm --filter @passport/desktop test    # Mac app unit tests and the Electron FTS5 probe
```

Changes to `apps/desktop` should also pass `pnpm dist:desktop`, which packages and smoke-tests the
app (macOS, Apple silicon); see [the Mac app guide](docs/desktop.md).

Biome reads `biome.json`; the commented `biome-baseline.jsonc` records existing warning
rules that need manual review without changing behavior. Package-local lint commands remain
TypeScript checks.

Open a pull request against `main`. CI runs build, typecheck, Biome checks and tests on Node 22 and 24.

## Code style

The Biome formatter is authoritative. Use `pnpm format` before submitting changes and `pnpm lint`
to check formatting, imports, lint rules, and workspace types. `pnpm format:check` checks only
formatting; CI's `pnpm lint` already covers it. Package-local lint scripts remain TypeScript checks.

- Put one statement on each line and use braces around control-flow bodies. Prefer named
  intermediate values and early returns over dense nested expressions.
- Make every catch explicit: narrow and explain an expected ignored error, retain its fallback
  with a safe diagnostic, or propagate a typed error with a stable code. Comment the fallback
  and never log raw provider errors, credentials, message bodies, or token-bearing URLs.
- Aim for files under about 400 lines and split at natural responsibility boundaries. Keep
  related state and operation order together rather than adding layers to meet a line count.
- Keep `packages/types` append-only in substance: add compatible contracts, never remove or
  reshape existing ones as cleanup. Preserve package-root APIs unless their removal is agreed.

The commented baseline in `biome-baseline.jsonc` keeps existing behavior-sensitive findings as
warnings; each rule explains why. Review fixes individually and use no file-level suppressions.
The formatting revision is listed in `.git-blame-ignore-revs`; use
`git blame --ignore-revs-file .git-blame-ignore-revs` to see past it.

## Reporting a security issue

Do not open a public issue. Follow [SECURITY.md](SECURITY.md) to report privately.
