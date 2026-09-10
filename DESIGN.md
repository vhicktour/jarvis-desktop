---
version: alpha
name: Jarvis
description: A luminous instrument in native glass that follows a Mac user's work.
colors:
  ink: '#08121A'
  pearl: '#EAF7FF'
  steel: '#91AAB8'
  cyan: '#8EE7F5'
  amber: '#D5AF74'
  coral: '#EF8C83'
typography:
  display:
    fontFamily: 'Sora, sans-serif'
  body:
    fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif'
  mono:
    fontFamily: 'SFMono-Regular, ui-monospace, monospace'
rounded:
  control: '12px'
  panel: '28px'
  core: '36px'
spacing:
  unit: '4px'
  inset: '24px'
  section: '32px'
components:
  Button: {}
  Field: {}
  Status: {}
  Dialog: {}
  Companion: {}
---

# Jarvis design system

## Overview

Jarvis is a product interface for a single developer working across macOS apps. The visual reference is a precision instrument suspended in glass: a dotted, three-dimensional core, quiet typography, and measured activity. The core owns the expressive motion. Settings, memory, and receipts are calm and readable. English is the first locale; dates follow the user's system timezone.

This file owns the palette, fonts, radii, and spacing above. `scripts/tokens.mjs` generates `src/renderer/styles/tokens.css`; feature styles consume these variables. The native material receives its tint from the shared design token export. Behavioral ownership lives in UX-CONTRACT.md.

## Colors

Ink is the dark base; pearl is primary text. Steel labels supporting information. Cyan marks activity and selection, amber requests a decision, and coral identifies errors. State also has a text label and icon. Native glass provides the exterior material. Dense reading surfaces add a restrained ink backing for contrast. Accessibility modes use opaque surfaces and system contrast colors.

## Typography

Sora appears in identity and headings. System text carries conversation and controls at 14–15px with a 1.5 line height. Monospace appears only in shortcuts, timestamps, paths, and exact technical evidence. Avoid long uppercase passages; small uppercase labels describe genuinely distinct sections.

## Layout

The 72px core docks 24px inside the display work area and is the primary interface. Listening, thinking, searching, and working remain orb states; they never automatically open a workspace or conversation window. A small hover/context menu exposes Settings, text input, task details, and voice controls. Explicitly opened details and required approvals use anchored panels that grow inward. Settings alone opens a full, resizable window with a 192px navigation rail. Expanded surfaces use 24px padding and a 4px spacing rhythm. Text input and approval actions stay reachable in short windows. Long content scrolls inside its owner.

## Elevation & Depth

One native glass layer sits behind each Electron surface. Thin luminous edges and restrained shadows articulate the silhouette. Interior controls use quiet tonal separation. Borders and glow never compete with body text. Browser development previews label their simulated desktop and glass explicitly.

## Shapes

The core is circular, the listening surface is a capsule, and reading panels have 28px corners. Controls use 12px corners. Dragging moves the window; it does not distort words or hit targets.

## Components

Button owns pointer, keyboard, hover, focus, pressed, disabled, and pending states; busy buttons keep their width. Field owns labels, validation, and hints. Dialog owns focus trapping, Escape, and focus restoration. Status owns semantic text and tone. Companion maps actual task/conversation events to the orb. Lucide icons use consistent strokes and accessible labels.

Motion uses a shared 300ms spring transition. Liquid-gooey animates small control groups with contentBlur=0 and restrained bounce. The core itself sways and expands with measured playback volume. No perimeter beam, orbiting bar, or audio ring surrounds it. Orbs settle when idle and pause when hidden. Reduce Motion disables travel and decorative loops; Reduce Transparency replaces the glass backing with ink. Shared scrollbars remain visible and operable.

## Do's and Don'ts

- Do show exact actions and evidence with concise, ordinary words.
- Do reserve the strongest motion for the companion's state changes.
- Do preserve contrast over real desktop content.
- Do not show invented progress, fake telemetry, or completion without evidence.
- Do not add decorative dashboards, continuous scanning, or moving controls during approvals.
