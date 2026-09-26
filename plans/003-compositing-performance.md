# 003 — Composite-friendly transitions (transform/opacity only)

- **Status**: DONE commits 1-2 (5b4324e, cd8203f on `modern-ui`); optional commit 3 (virtualization spacers) intentionally skipped — needs manual jitter verification per its own abandon protocol
- **Commit**: 7889cfd
- **Severity**: HIGH (finding 2), MEDIUM (11), LOW-MEDIUM and OPTIONAL (18)
- **Category**: Performance (audit findings 2, 11, 18)
- **Estimated scope**: 6 files, ~40 lines
- **PR**: C — `perf(webapp): composite-friendly transitions`

## Problem

Performance is the project's #1 constraint (Preact-over-React choice), yet several transitions animate properties that force layout or paint every frame.

**Finding 2 — `transition: all` on the two most-used element classes:**

```css
/* webapp/src/styles/forms.css:26 — current */
.input { … transition: all var(--dur-fast) var(--ease-smooth); }

/* webapp/src/styles/forms.css:130 — current */
.btn { … transition: all var(--dur-fast) var(--ease-smooth); }
```

**Finding 11 — layout/paint-animating transitions:**

```css
/* webapp/src/styles/management.css:1756-1760 — current (restore meter animates width) */
.restore-progress-meter-bar { @apply block h-full rounded-[inherit]; background: #3a71d8; transition: width 280ms ease; }
/* driven from webapp/src/components/BackupCenterPage.tsx:1048: width: `${((restoreProgress.phaseIndex + 1) / restoreProgress.phases.length) * 100}%` */

/* webapp/src/styles/management.css:2023-2025 — current (domain rules animate max-height) */
.domain-rule-domains { … transition: max-height 180ms var(--ease-out-soft), opacity 140ms var(--ease-smooth); }

/* webapp/src/styles/skeleton.css:18/30/46 — current (shimmer animates background-position, repaints per frame) */
animation: shimmer 1.5s ease-in-out infinite;  /* with background-size: 200% 100% */

/* webapp/src/styles/shell.css:265 — ACCEPTED, no change: grid-template-rows 0fr→1fr side-subnav accordion.
   Occasional-tier, standard modern technique; documented tradeoff. */
```

**Finding 18 (OPTIONAL COMMIT — risky) — virtualization spacers mutate `padding`** on every scroll tick of the app's core surface:

```tsx
/* webapp/src/components/vault/VaultListPanel.tsx:432 — current */
<div style={{ paddingTop: `${props.virtualRange.padTop}px`, paddingBottom: `${props.virtualRange.padBottom}px` }}>
```

The team already fought scroll-anchoring jitter here (comment at `vault.css:436-438`); treat this section as optional and abandon it at the first sign of jitter.

## Target

```css
/* forms.css:26 — target */
.input { … transition: border-color var(--dur-fast) var(--ease-smooth), background-color var(--dur-fast) var(--ease-smooth), box-shadow var(--dur-fast) var(--ease-smooth); }
/* (transform is no longer transitioned: plan 001 removed the focus lift) */

/* forms.css:130 — target */
.btn { … transition: transform var(--dur-fast) var(--ease-smooth), background-color var(--dur-fast) var(--ease-smooth), border-color var(--dur-fast) var(--ease-smooth), color var(--dur-fast) var(--ease-smooth), box-shadow var(--dur-fast) var(--ease-smooth); }

/* management.css:1756-1760 — target (scaleX, composites) */
.restore-progress-meter-bar { @apply block h-full rounded-[inherit]; background: #3a71d8; transform: scaleX(0); transform-origin: left center; transition: transform var(--dur-medium) var(--ease-smooth); }

/* management.css:2023-2025 — target (instant reveal + opacity fade kept) */
.domain-rule-domains { … transition: opacity 140ms var(--ease-smooth); }

/* skeleton.css — target: one overlay shimmer, transform-based (pattern already exists at styles.css:217-233) */
.skeleton-avatar, .skeleton-icon, .skeleton-line { position: relative; overflow: hidden; /* existing background gradient stays, background-size removed */ }
.skeleton-avatar::after, .skeleton-icon::after, .skeleton-line::after {
  content: ''; position: absolute; inset: 0; transform: translateX(-100%);
  background: linear-gradient(90deg, transparent 0%, color-mix(in srgb, white 38%, transparent) 48%, transparent 100%);
  animation: loading-shimmer 1.25s ease-in-out infinite;
}
/* delete `animation: shimmer …` from the three base rules; the `shimmer` keyframe in motion.css becomes unused → delete it there if `rg "shimmer" webapp/src/styles` shows no other user */
```

```tsx
/* BackupCenterPage.tsx:1048 — target */
style={{ transform: `scaleX(${(restoreProgress.phaseIndex + 1) / restoreProgress.phases.length})` }}
```

## Repo conventions to follow

- Transform-based shimmer exemplar: `styles.css:212-233` (`.shimmer::after` + `@keyframes loading-shimmer`).
- Token exemplar for durations: `var(--dur-medium)` 240ms, `var(--ease-smooth)` for on-screen value changes.

## Steps

Commit 1 — explicit transition lists:
1. `forms.css:26` and `forms.css:130`: replace `transition: all …` with the target lists above. Run `rg 'transition:\s*all' webapp/src` afterwards — it must return nothing.

Commit 2 — layout animations:
2. `management.css:1756-1760`: replace the width transition with the `scaleX` target. Update `BackupCenterPage.tsx:1048` to set `transform: scaleX(fraction)` instead of `width`. The bar keeps `h-full` so its painted size is unchanged.
3. `management.css:2023-2025`: delete the `max-height` leg from the transition. The expanded state (`domain-rule-domains-expanded`, `max-height: 220px`) still applies instantly; the 140ms opacity fade remains as the bridge.
4. `skeleton.css`: add `position: relative; overflow: hidden;` to `.skeleton-avatar`, `.skeleton-icon`, `.skeleton-line`; remove `background-size: 200% 100%` and the `animation: shimmer …` declaration from those three rules; add the shared `::after` overlay rule; if `shimmer` (motion.css:67) is now unreferenced, delete the keyframe. Check `dark.css` for a dark-mode variant of the overlay gradient — if `.shimmer::after` has one, mirror it for the skeleton overlay (white 38% may need `--panel-soft` in dark mode); if unsure, keep `color-mix(white 38%)` which styles.css already ships in both themes.

Commit 3 (OPTIONAL — attempt last, abandon on any regression) — virtualization spacers:
5. `VaultListPanel.tsx:432`: replace the padding-mutating wrapper with a non-layout spacer: outer `<div style={{ height: totalHeight }}>` (parent must already know or compute total = padTop + rendered rows' height + padBottom — inspect `props.virtualRange`'s source for a total field; if absent, `height: padTop + visibleHeight + padBottom` measured from the row count × row height), inner `<div style={{ transform: `translateY(${padTop}px)` }}>` wrapping the mapped rows.
6. Manual verification on a vault with 500+ items: fast scrolls, slow scrolls, scrollbar drag, and window resize must show **zero** jitter or misplaced rows. Any anomaly → revert commit 3 entirely.

## Boundaries

- Do NOT touch `shell.css:259-274` (side-subnav grid accordion) — accepted tradeoff, documented.
- Do NOT change what is communicated (meter fractions, expand state) — only how it animates.
- The restore-meter change touches one TSX line; no other JSX changes in commits 1-2.
- If any cited line no longer matches (drift since 7889cfd, or plans 001/002 already landed and changed line numbers), STOP and report.

## Verification

- **Mechanical**: `npm run build` succeeds. `rg 'transition:\s*all' webapp/src` empty.
- **Feel check**:
  - Run a backup restore in the backup center: the meter fills smoothly; DevTools → Performance → record it: **no layout events** during the fill (only composites).
  - Domain rules page: expanding a row reveals text instantly with a fast opacity fade; no height tween.
  - Vault with slow network → skeleton: shimmer sweeps smoothly; DevTools rendering FPS graph shows no paint storms while skeletons are visible.
  - Buttons/inputs: hover and focus still transition color/shadow exactly as before (160-180ms feel unchanged).
  - With commit 3: scroll the vault list hard for 10 seconds; no jitter, no blank rows, scrollbar proportional.
- **Done when**: no `transition: all`, no animated `width`/`max-height`, skeleton shimmer is transform-based, build passes.
