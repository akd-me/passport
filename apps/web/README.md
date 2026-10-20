# @passport/web

React 19 + Vite + strict TypeScript. Six calm, dark views with hand-written responsive CSS, inline SVG icons, and no UI framework. The only production dependencies are React, React DOM, React Router, and `@passport/types`.

```sh
# Repository root, Node 25 and pnpm 10
pnpm install
pnpm --filter @passport/types build
pnpm --filter @passport/server demo
# Another terminal:
pnpm --filter @passport/web dev  # http://localhost:5173
# Or pnpm build; server then serves the production UI on :3000
pnpm --filter @passport/web build
pnpm --filter @passport/web test
```

Vite proxies `/api` and `/ws` to port 3000. Use the same origin for frontend requests; no API CORS is needed. If the backend uses another port, change the Vite proxy. `src/api.ts` uses the frozen shared domain types, while local DTOs describe HTTP envelopes. The app imports no server internals.

- **Decisions** (`/`): the only inbox. Matter-grouped proposals, source email context, editable draft bodies, approval/rejection, held-send countdowns/cancel. `j`/`k` select cards, `a` approves, `r` rejects, `e` edits. Shortcuts ignore form fields and modifiers.
- **Matters** (`/matters`, `/matters/:id`): status/search filters, summary and next step, people, calendar and email/action timeline. Status updates pass through the server action executor and are undoable.
- **People** (`/people`, `/people/:id`): relationship context, shared matters and correspondence. Blue/green badges use only `Person.verification`. A green person with `lastSeenBlueAt` gets a downgrade warning.
- **Trust** (`/trust`): Supervised / Auto-accept edits / Auto / Full access picker, category scores/stages/counts/pins, promotion offer, outbox hold/decay/always-ask/external ceiling controls. Global mode caps category pins.
- **Activity** (`/activity`): dated action log, status/category/actor filters, pagination, undo, and a cancellable outbox.
- **Accounts** (`/accounts`): descriptor-driven setup and sync, LLM provider/model/base URL/fast model preferences, and USER.md editor. Account secret inputs are passwords, cleared after successful submission. LLM keys are server environment-only.

`WorkspaceProvider` maintains a reconnecting WebSocket subscription to `/ws` (`DomainEvent` JSON), debounces resource invalidation, and refetches after reconnect/focus. In-flight HTTP reads are aborted on unmount/change. Mutations disable duplicate actions, show errors without discarding drafts, invalidate current data, and show confirmation toasts. Streaming edits never replace the body you are actively composing.

The demo uses 40 fixture emails, eight people, six matters, four events, a toy policy/executor, and a toy agent. No provider or model calls run; all edits reset on server restart. Mock is the only demo account provider. Real OAuth setup, production inference, provider dispatch, and durable storage need server integration; see `apps/server/src/compose.ts`.

Vitest + Testing Library cover decision approval, editing/focus, rejection/pending controls, cancellation/countdown, failures, empty drafts, and trust mode selection. Both app READMEs describe integration limits. The interface supports narrow screens, reduced motion, keyboard focus, and a skip-to-content link.
