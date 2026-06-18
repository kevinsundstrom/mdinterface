# Contributing to mdinterface

Thanks for taking a look. mdinterface is a small, dependency-light tool, and the goal is to keep
it that way.

## Getting started

```bash
npm install
node server.js README.md   # or: npm start
```

Requires Node 18+ (`.nvmrc` pins 20) and the `claude` CLI on your PATH.

## Dev workflow

| Command | What it does |
|---|---|
| `npm run lint` | Biome lint + format check (what CI runs) |
| `npm run format` | Biome auto-format in place |
| `npm run typecheck` | `tsc --noEmit` — type-checks the JS via JSDoc, **no build step** |
| `npm test` | `node:test` suite (no test framework dependency) |

CI (`.github/workflows/ci.yml`) runs lint, typecheck, and test on Node 18/20/22. Please make
sure all three pass locally before opening a PR.

## Conventions

- **Plain JS, type-checked.** The code is CommonJS with `checkJs` (see `tsconfig.json`), so you
  get type safety from JSDoc without a compile step. Add JSDoc to new functions where it
  documents a real contract.
- **Formatting is Biome's** (`biome.json`) — run `npm run format`; don't hand-format.
- **Tests use the built-in `node:test`** — no Jest/Vitest. Pure logic (e.g. `access.js`, the
  edit matcher in `mcp-server.js`) should be importable and unit-tested; modules guard their
  side effects behind `require.main === module` so they can be imported by tests.

### Two intentionally-disabled lint rules

These are off in `biome.json` on purpose, not by accident:

- **`a11y` (all)** — mdinterface is a local, single-user, mouse-driven dev tool, not a public web
  app. Full ARIA/keyboard semantics on the resize divider and toolbar aren't a meaningful goal
  here, and chasing them would distort the markup. If mdinterface ever ships a hosted UI, revisit.
- **`suspicious/noEmptyBlockStatements`** — the server makes many best-effort filesystem writes
  (`try { … } catch {}`) where failure is genuinely fine to ignore; empty catches there are
  deliberate and commented.

## Security note

mdinterface runs a live shell/Claude session over a loopback WebSocket. Keep that boundary intact:
no LAN binding, the per-launch token stays required on every request, and rendered markdown
stays sanitized. See the **Security** and **Threat model** sections in the README before
changing anything in `access.js`, the WebSocket handlers, or the rendering path.
