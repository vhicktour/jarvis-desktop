# Jarvis verification — 10 September 2026

This is a personal preview for macOS 26+ on Apple silicon. It is not a claim that every roadmap milestone has passed qualification. Tested on an M1 Pro, 16 GB, macOS 27.0.

## Observed results

- TypeScript check passes. The core suite passes 18 tests, including encrypted database/WAL storage, reopen and wrong-key rejection, scoped memory deletion, stale approvals, uncertain effect recovery, cancellation, steering, shutdown, filesystem/network restrictions, safe file-write resumption, and cumulative usage across revisions.
- `spoken-task.json`: Kokoro synthesized a request; Parakeet transcribed it; the local planner proposed a file; the fixture approved only its exact disposable destination; the native tool created it; its content hash was verified in a receipt. This uses synthesized input, not a live microphone route.
- `local-model-smoke-corrected.json`: Kokoro, Parakeet, independent MLX Whisper, Qwen reasoning, and 1024-dimensional embeddings pass the sample. Peak MLX allocation was about 3.25 GB. That is not a measurement of the full application’s standard-workload memory.
- Smart Turn did not classify the finished synthesized sentence above the conservative threshold. Automatic endpointing stays experimental and off by default. VAD recognized speech and rejected silence.
- `native-audio.json`: 100 native playback-stop trials passed on MacBook Pro Speakers, with p95 10.79 ms at that boundary and varying playback-meter samples. This measures NDJSON request through AVAudioPlayer.stop acknowledgment; it does not measure acoustic barge-in latency.
- The strict design audit reports 44 findings: 43 mistake React Aria `Button` / `onPress` for inert native buttons; one mistakes React Aria `Select` for a native select. The unmodified report is retained in `premium-audit.json`; `design-audit-review.json` records the actual JSX tags and action attributes at all 44 locations. Its automated result remains failed; this is a documented detector limitation, not a clean-audit claim.

## Implemented preview

The only default surface is a draggable 72-point native glass orb. Sphere movement reflects actual activity and playback level; no traveling bar, perimeter beam, or audio ring is rendered. The orb settles when idle and respects Reduce Motion. Settings is the only full window. Text, conversation, context, task evidence, and exact approvals are opened in compact panels.

The preview includes the encrypted task and memory service, explicit local file creation, separate media and credential helpers, pinned private Python runtime, model install/repair controls, local speech and reasoning, selected-window capture with an explicit one-frame-per-second follow mode, scoped recall, routines and repository watchpoints, Codex/Claude adapter code, Apple EventKit connectors, selected Mail metadata/content, and read-only Google OAuth adapters.

## Not qualified or not implemented

- Codex/Claude paid end-to-end execution and live Apple/Google connector effects have not been exercised with user credentials. Codex sandbox behavior beyond its documented workspace-write policy needs qualification before distribution.
- Apple Mail sending, Google writes, full selected-tab content integration, region selection, Accessibility action execution, and visual GUI fallback are not enabled in this preview.
- Hands-free/duplex and experimental models are disabled pending device-specific qualification. Partial live transcription is not yet implemented; recognition uses finalized recordings.
- Scheduled work requires Jarvis to be running. Routines and watchpoints have not completed live long-duration qualification.
- Full-screen Spaces, multiple displays/scales, display removal, sleep/wake, all accessibility settings, 60 fps, combined memory under the standard workload, and 100 acoustic interruption trials per route remain release checks.
- Signing with a Developer ID, notarization, and signed upgrade/Keychain ACL migration have not been validated. The packager discovered the existing Developer ID and is configured to sign the bundle. Signature verification and installed launch are recorded separately below.

## Repeatable checks

```sh
pnpm typecheck
pnpm test
pnpm native:build
node --import tsx scripts/verify-native-audio.ts
node --import tsx scripts/verify-models.ts /path/to/disposable-profile
node --import tsx scripts/verify-spoken-task.ts /path/to/disposable-profile
pnpm package
```

Model fixtures require the installed, pinned model weights. They do not connect cloud providers. Keep QA profiles and their encrypted ledgers separate from personal app data.
