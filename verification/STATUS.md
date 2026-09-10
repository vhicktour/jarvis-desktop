# Jarvis verification — 10 September 2026

This is a personal preview for macOS 26+ on Apple silicon. It is not a claim that every roadmap milestone has passed qualification. Tested on an M1 Pro, 16 GB, macOS 27.0.

## Observed results

- TypeScript check passes. The core suite passes 23 tests, including encrypted database/WAL storage, reopen and wrong-key rejection, scoped memory deletion, stale approvals, uncertain effect recovery, cancellation, steering, shutdown, filesystem/network restrictions, safe file-write resumption, cumulative usage across revisions, the model check contract, note indexing with credential redaction, the schema upgrade an existing database takes, and drawn-region geometry.
- `spoken-task.json`: Kokoro synthesized a request; Parakeet transcribed it; the local planner proposed a file; the fixture approved only its exact disposable destination; the native tool created it; its content hash was verified in a receipt. This uses synthesized input, not a live microphone route.
- `local-model-smoke-corrected.json`: Kokoro, Parakeet, independent MLX Whisper, Qwen reasoning, and 1024-dimensional embeddings pass the sample. Peak MLX allocation was about 3.25 GB. That is not a measurement of the full application’s standard-workload memory.
- `model-qualification.json`: every catalog model was exercised on this Mac in 23.8 s, peaking at about 3.27 GB of MLX allocation. Each check runs the behavior that role is relied on for and writes the result, with its date, into the model’s own manifest, so Settings reports an observation rather than an assumption. Six of the seven installed models passed: Kokoro (24 kHz, 3.85 s, 0.336 peak, 0.0577 RMS), Parakeet and Whisper (both returned the rendered sentence exactly, at 1.7× and 6.9× realtime once loaded), Qwen 3.5 (a determinate answer and a parseable task action envelope), Qwen Embedding (1024 dimensions, related text at 0.869 against 0.491 for unrelated text), and Silero (speech, silence, and speech still in progress separated in three of three takes). The four research profiles cannot be installed, so they are recorded as unqualified with that reason rather than left blank.
- Smart Turn is the one installed model that is not qualified here. It refused to finish a turn on silence and on speech still in progress in three of three takes, but its finished-sentence probability stayed under the 0.65 product threshold in every take, and varies widely between renders of the same sentence: 0.214, 0.403 and 0.490 in the recorded run, and 0.347 in the separate interface smoke check. Synthesis is not bit-identical between renders, which is why endpointing is judged over three takes and the lowest one decides. Automatic endpointing therefore stays experimental, and Settings now refuses to switch it on until Silero and Smart Turn both pass their checks on the Mac in use. This is a synthesized-speech result; Smart Turn is trained on human speech, so a microphone-route measurement is still required before drawing any conclusion about the model itself.
- `vault-recall.json`: a 145-note folder (1.50 MB) was indexed into 1179 passages, all of them embedded, in 211 s. Six passages that read like credentials were left out and never reached a model, and no files were skipped. Two recall questions each returned the note that answers them, in 50 ms and 76 ms including the query embedding, inside the 300 ms retrieval target. Forgetting the index left nothing recall could reach. The notes themselves were never modified. Note titles and excerpts stay in `verification/private`, which git ignores.
- `region-capture.json`: the native helper cropped this screen to order. A whole display came back at 1280 × 827 points after the 1280-point scale, each half at 1028 × 1329, and the two halves produced different pixels, so the crop is positioned rather than merely sized. Asking for an area holding an excluded application was refused, as were an area under sixteen points and an area off every display. Jarvis's own surfaces are excluded from the shot, so the selector never appears in it.
- The area selector itself was driven in a browser against the development preview: the scrim, the drawn rectangle, and the hint bar render; arrow keys create and move a rectangle, Shift with them resizes it, Enter reports the exact points drawn, a pointer drag reports the same, and Escape cancels. That exercises the interface and its geometry, not the Electron window that carries it on a real desktop.
- `native-audio.json`: 100 native playback-stop trials passed on MacBook Pro Speakers, with p95 10.86 ms at that boundary and varying playback-meter samples. This measures NDJSON request through AVAudioPlayer.stop acknowledgment; it does not measure acoustic barge-in latency.
- The strict design audit reports 44 findings: 43 mistake React Aria `Button` / `onPress` for inert native buttons; one mistakes React Aria `Select` for a native select. The unmodified report is retained in `premium-audit.json`; `design-audit-review.json` records the actual JSX tags and action attributes at all 44 locations. Its automated result remains failed; this is a documented detector limitation, not a clean-audit claim.

## Implemented preview

The only default surface is a draggable 72-point native glass orb. Sphere movement reflects actual activity and playback level; no traveling bar, perimeter beam, or audio ring is rendered. The orb settles when idle and respects Reduce Motion. Settings is the only full window. Text, conversation, context, task evidence, and exact approvals are opened in compact panels.

The preview includes the encrypted task and memory service, explicit local file creation, separate media and credential helpers, pinned private Python runtime, model install/repair controls, per-model checks that record what was observed in the model manifest, a chosen notes folder indexed for recall beside memory, memories the model suggests and the person accepts, pointer and keyboard selection of a screen area, local speech and reasoning, selected-window capture with an explicit one-frame-per-second follow mode, scoped recall, routines and repository watchpoints, Codex/Claude adapter code, Apple EventKit connectors, selected Mail metadata/content, and read-only Google OAuth adapters.

## Not qualified or not implemented

- Codex/Claude paid end-to-end execution and live Apple/Google connector effects have not been exercised with user credentials. Codex sandbox behavior beyond its documented workspace-write policy needs qualification before distribution.
- Apple Mail sending, Google writes, full selected-tab content integration, Accessibility action execution, and visual GUI fallback are not enabled in this preview.
- The area selector has not been exercised as an Electron window on a real desktop: whether it takes the keyboard, floats above a full-screen Space, and behaves across several displays are manual checks. A drawn area is a single observation and cannot be followed; only a window can.
- Hands-free/duplex and experimental models are disabled pending device-specific qualification. Automatic endpointing cannot be switched on until Silero and Smart Turn both pass their checks on the Mac in use. Partial live transcription is not yet implemented; recognition uses finalized recordings.
- A connected notes folder joins recall in the personal scope only; a project-scoped conversation does not search it. The first index of a large folder is dominated by embedding and runs in the background, with its stage visible in Settings. Credential redaction is a bounded pattern match, not a guarantee that every secret is caught.
- Scheduled work requires Jarvis to be running. Routines and watchpoints have not completed live long-duration qualification.
- Full-screen Spaces, multiple displays/scales, display removal, sleep/wake, all accessibility settings, 60 fps, combined memory under the standard workload, and 100 acoustic interruption trials per route remain release checks.
- Signing with a Developer ID, notarization, and signed upgrade/Keychain ACL migration have not been validated. The packager discovered the existing Developer ID and is configured to sign the bundle. Signature verification and installed launch are recorded separately below.

## Repeatable checks

```sh
pnpm typecheck
pnpm test
pnpm native:build
node --import tsx scripts/verify-native-audio.ts
node --import tsx scripts/verify-region-capture.ts
node --import tsx scripts/verify-models.ts /path/to/disposable-profile
node --import tsx scripts/verify-model-qualification.ts /path/to/disposable-profile
node --import tsx scripts/verify-spoken-task.ts /path/to/disposable-profile
node --import tsx scripts/verify-vault-recall.ts /path/to/notes /path/to/disposable-profile
pnpm package
```

Model fixtures require the installed, pinned model weights. They do not connect cloud providers. Keep QA profiles and their encrypted ledgers separate from personal app data.
