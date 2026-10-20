# Contributing to Passport

Thanks for helping build an agent-native email harness.

## Ground rules

- Read `docs/CONTRACT.md` first. It defines the package boundaries and the invariants
  (every state change is a logged Action; sends are held in the outbox; verification never
  comes from message content; external agents are capped by policy).
- `packages/types` is the contract. Add, don't rename. A change there is a cross-package change.
- No native modules. Node ≥ 22.5, pnpm 10, TypeScript strict, vitest.
- Tests run offline. Use the mock providers and in-memory stores; never hit a live API in tests.
- Never log credentials or full message bodies.

## Workflow

```sh
pnpm install
pnpm build
pnpm test
pnpm --filter @passport/server demo     # UI on fixture data
```

Open a pull request against `main`. CI runs build, typecheck and tests on Node 22 and 24.

## Reporting a security issue

Email the maintainer directly rather than opening a public issue.
