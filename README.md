# Passport

Agent-native email. An open-source, local-first harness that lets AI agents handle your mail, calendar and
contacts under a trust policy you control, with every action logged and undoable. Bring your own mail
providers and your own models.

Status: runnable in-memory demo; real backend composition is pending integration. See `docs/CONTRACT.md` for the architecture and `docs/` for the design notes.

```
pnpm install
pnpm build
pnpm dev            # starts the local server
```

## Try the demo

Requires Node 25 and pnpm 10. From the repository root:

```sh
pnpm install && pnpm build && pnpm --filter @passport/server demo
```

Open **http://127.0.0.1:3000**. The demo includes 40 realistic emails, six matters, eight people, four
calendar events, decisions with editable drafts, a delayed outbox, undo, trust controls, account setup,
and a USER.md editor. Everything runs in memory; no real email is sent and no model API is called.
Changes reset on restart. Use `PASSPORT_PORT` to change the port.

During the parallel-build wave, `pnpm build` builds the frozen shared types and both apps.
`pnpm build:all` preserves the full workspace build for integration once the other packages have
implementations. `passport serve` and real MCP composition intentionally remain integration stubs.
See [server documentation](apps/server/README.md) for API/config/CLI details and
[web documentation](apps/web/README.md) for the views and development workflow.
