# Jarvis

A local-first Electron companion for macOS 26+ on Apple silicon.

## Development

```sh
pnpm install
pnpm native:build
pnpm dev
```

`Command–Shift–J` opens voice interaction. The floating orb is the main interface; its menu opens Settings or compact task/conversation panels. Provider connections, projects, local models, and privacy settings are managed in the Settings window.

## Checks and packaging

```sh
pnpm typecheck
pnpm test
pnpm package
```

`pnpm models:setup` prepares the pinned Python model runtime. Model weights are downloaded explicitly through the app. `pnpm dist` creates distributable artifacts; signing and notarization are validated separately.

The task service is authoritative for approvals, revisions, effects, and completion. Renderer state is a projection. Model and provider workers communicate through bounded protocols. See DESIGN.md and UX-CONTRACT.md for visual and behavioral ownership, and verification/STATUS.md for observed qualification results.
