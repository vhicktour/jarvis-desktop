# Jarvis interaction contract

Source: the user-approved Jarvis plan and the supplied Continuum PRD, adapted to Electron. Runtime business contracts are in `src/shared/contracts.ts`. Core task and permission rules are enforced in the service, independently of the renderer.

## Canonical UI Map

| Capability     | Canonical owner                     | Source of truth        | Allowed variants                                  | Verification                    |
| -------------- | ----------------------------------- | ---------------------- | ------------------------------------------------- | ------------------------------- |
| Form           | Field and form schema               | Shared command schemas | create / edit                                     | UI and invalid command tests    |
| Select/Listbox | React Aria Select                   | This contract          | authored                                          | Keyboard / popup tests          |
| Date           | Field                               | This contract          | typed local datetime with timezone label          | Schedule tests                  |
| Scrollbar      | Global styles                       | DESIGN.md              | compact overlay                                   | Computed style and scroll tests |
| Toast          | Notice provider                     | This contract          | success / info / warning / error                  | Live region and deduplication   |
| CRUD           | Memory and Routine service commands | Domain schemas         | local save / confirmed delete                     | Service and UI tests            |
| Dialog         | React Aria Dialog                   | This contract          | approval / confirmation                           | Focus, Escape, pending recovery |
| Overlay        | WindowCoordinator and Companion     | Shared overlay state   | core / listening / conversation / task / approval | Native and UI tests             |

## State and navigation

Conversation, voice, task, and context states are independent. Stopping speech invalidates pending playback; pausing or cancelling work requires its own command. A task records revisions, effects, and evidence. Provider success enters verification. Completion requires evidence for the current revision. Unknown effect outcomes require reconciliation.

The floating orb is the application interface. Activity changes its animation, without automatically expanding into conversation or task dashboards. Clicking the orb starts or stops voice interaction. Its menu offers Type a request, Current task, Recent conversation, Settings, and controls for speech/work. Settings is the only full window, with General, Voice, Models, Connections, Memory, Routines, Privacy, and Diagnostics sections. Task details and required approvals use anchored overlay panels. Search has a labeled clear control. Lists show an explicit empty state, local filtering, and bounded pages. Streaming conversation follows new output only while the reader is at the bottom.

Forms use noValidate and shared validation. Successful local saves keep the current context and show a deduplicated notice. Errors preserve entered values and offer a specific recovery. Buttons do not duplicate pending requests. Modal confirmations name the object and consequence; Escape cancels and restores focus. Menus never depend on hover alone. Secrets are masked and never appear in notices, renderer snapshots, logs, or localStorage.

## Permissions and effects

Selected projects and observations define context scope. An excluded application inside a drawn screen area refuses the capture, exactly as it does for a window. A model, repository, webpage, note, or tool output cannot grant permission. Approvals bind to task revision, canonical arguments, target identity, policy version, and expiry. External sends and changes require exact payload review. Missing enforcement disables the affected effect. Locking the Mac pauses new effects.

## Data and recovery

Memory a model infers is proposed, never assumed: a proposed memory stays out of recall until the person accepts it, and accepting it restores its embedding. Raw audio and captures are ephemeral. Transcripts expire after 30 days, task receipts after 90 days, explicit memories when deleted. Forgetting also removes embeddings and derived retrieval data. A chosen notes folder is indexed rather than copied into memory: passages that read like credentials are never indexed, the notes themselves are never modified, and forgetting the index removes its passages and their embeddings. Local encrypted storage is required for durable user content. Local-only mode never silently uses a cloud model. Provider loss preserves tasks; uncertain mutations are not retried automatically. Worker restarts are bounded.

## Native interaction

Passive overlays use showInactive and never steal focus. Explicit text entry and drawing a screen area may focus Jarvis. The area selector answers the pointer and the keyboard alike: arrow keys move the area, Shift with them resizes it, Enter shares it, Escape cancels it, and it never appears in its own capture. Pinning disables automatic travel. Approvals, dragging, and pointer/keyboard interaction suspend automatic movement. Saved anchors are clamped after display changes. Transparent margins pass through clicks. Shortcut registration failure is shown in Settings and never silently changes the configured shortcut.

## Accessibility and locale

Target WCAG 2.2 AA, system timezone, en-US messages, keyboard alternatives for dragging, visible focus, semantic labels, reduced motion, reduced transparency, and sufficient contrast. Respect IME composition when submitting text. Critical errors and approvals remain available until resolved.
