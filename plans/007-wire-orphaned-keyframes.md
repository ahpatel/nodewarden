# 007 — Wire the orphaned keyframes (route, unlock, popover, settings, chevron)

- **Status**: DONE (commits 72e5d2e, db11406, cd60475, f138d3c, d78dfad on `modern-ui`; O3 adopted the plan-004 persistent pattern as its step 6 anticipated, and the plan's `menu-in` reuse was replaced by it since 004 deleted that keyframe)
- **Commit**: 7889cfd
- **Severity**: MEDIUM (additive)
- **Category**: Missed opportunities (gated audit, opportunities 1, 2, 3, 4, 6)
- **Estimated scope**: 5 files, ~25 lines added
- **PR**: G — `feat(webapp): wire prepared entrance animations (route, unlock, popover, settings)`

## Problem

The motion system has orphaned inventory: keyframes that were purpose-built for real gaps and never wired. Each opportunity below passed the frequency/purpose/speed/function gate. All verified at 7889cfd (lines may have shifted after plans 001-006 — re-locate by quoted code).

**O1 — route changes teleport** (tens/day — gated to the subtle end). The keyed remount already exists and is *named for this*:

```tsx
/* webapp/src/components/AppAuthenticatedShell.tsx:220 — current */
<div key={routeAnimationKey} className={`route-stage ${…}`}>
```
```css
/* webapp/src/styles/shell.css:356-358 — current (no animation) */
.route-stage { @apply h-full min-h-0 overflow-auto; }
```
```css
/* webapp/src/styles/motion.css:62-65 — unused */
@keyframes route-stage-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
```

**O2 — unlock → dashboard hard-cuts** (rare/session-start — delight tier). `shell-enter` (motion.css:22-25: scale 0.98→1 + opacity) and `fade-in-up` (motion.css:17-20) are unused; neither `.app-shell` (shell.css:5-9) nor `.standalone-shell` (auth.css:455-457) has an entrance. Today "Unlocking…" → entire screen teleports to the shell — the app's highest-emotion moment rendered as a cut.

**O3 — the log-settings popover is the only popover that missed the menu pattern** (occasional):

```tsx
/* webapp/src/components/LogCenterPage.tsx:409-410 — current */
{settingsOpen && (<div className="log-settings-popover">
```
```css
/* webapp/src/styles/management.css:874-881 — current (no animation, no origin) */
.log-settings-popover { @apply absolute right-3 z-30 grid gap-3 rounded-xl border p-3; top: calc(100% + 8px); … }
```
Every sibling animates: `.sort-menu`, `.create-menu`, `.nav-layout-menu` all `menu-in` from their trigger.

**O4 — settings category tabs swap the whole panel instantly** (occasional). All five sections render through `{activeSection === '…' && <div className="settings-section-stack">…}` inside `.settings-category-panel` (SettingsPage.tsx:556-557 + 558, 596, 630, 762, 839; `.settings-category-panel` at management.css:583-592 has no animation). The vault's identical pattern animates via `.detail-switch-stage`'s fade.

**O6 — the mobile filter chevron snaps 0→180°** (tens/day — subtle end) while the identical side-nav chevron glides:

```css
/* vault.css:315-321 — current */
.mobile-vault-filter-chevron { @apply shrink-0; }
.mobile-vault-filter-trigger.active .mobile-vault-filter-chevron { transform: rotate(180deg); }
/* vs the exemplar: shell.css:250-253 .side-group-chevron { transition: transform 190ms var(--ease-out-soft); } */
```

## Target

```css
/* shell.css — target */
.route-stage { @apply h-full min-h-0 overflow-auto; animation: route-stage-in var(--dur-fast) var(--ease-out-soft) both; }
.app-shell { @apply relative flex flex-col; height: 100vh; background: var(--bg-accent); animation: shell-enter var(--dur-panel) var(--ease-out-strong) both; }

/* auth.css — target */
.standalone-shell { @apply grid w-[min(640px,100%)] gap-3.5; animation: fade-in-up var(--dur-panel) var(--ease-out-strong) both; }

/* management.css — target (if plan 004 made popovers persistent+open-class, use that pattern instead of the animation) */
.log-settings-popover { … animation: menu-in var(--dur-fast) var(--ease-out-strong) both; transform-origin: top right; }

/* management.css — target */
.settings-category-panel > .settings-section-stack { animation: fade-in var(--dur-fast) var(--ease-out-soft) both; }

/* vault.css — target */
.mobile-vault-filter-chevron { @apply shrink-0; transition: transform var(--dur-fast) var(--ease-out-soft); }
```

## Repo conventions to follow

- Popover exemplar: `.sort-menu` (`menu-in 190ms var(--ease-out-strong)`, origin at the trigger) — post-plan-005 the 190ms is `var(--dur-fast)`.
- Fade-swap exemplar: `.detail-switch-stage` fade (160ms `--ease-out-soft`) — use `var(--dur-fast)` here.
- Chevron exemplar: `.side-group-chevron` (shell.css:250-253).

## Steps

Commit 1 (drop-able — see note) — route entrances (O1):
1. `shell.css` `.route-stage`: add the target animation line.
2. Note: `.app-shell` does not remount on route change (the key is on the child), so O1 and O2 never stack. 180ms / 6px at tens/day is the gate's "near-imperceptible" tier — do not extend the duration or distance. If the maintainer prefers zero route motion, the alternative is one commit: remove `key={routeAnimationKey}` and delete `route-stage-in`; document both options in the PR description.

Commit 2 — unlock handoff (O2):
3. `shell.css` `.app-shell`: add the target animation.
4. `auth.css` `.standalone-shell`: add the target animation.
5. Verify no stacking: `rg 'app-shell|standalone-shell' webapp/src/components` — they are alternative roots (authenticated shell vs auth/public frames), never nested.

Commit 3 — log popover (O3):
6. `management.css` `.log-settings-popover`: add `transform-origin: top right;` (it is right-anchored at `right-3`, drops from `top: calc(100% + 8px)`) plus the entrance. If plan 004 converted menus/popovers to the persistent `.open` + transition pattern, convert this one the same way instead of adding a keyframe animation.

Commit 4 — settings panel (O4):
7. `management.css`: add the `.settings-category-panel > .settings-section-stack` fade. All five sections render through that wrapper, so one rule covers all.

Commit 5 — chevron (O6):
8. `vault.css`: add the transition to `.mobile-vault-filter-chevron`. Check whether the desktop duplicates-mode trigger uses the same chevron class (VaultListPanel.tsx:332/368) — it inherits the glide, which is correct for both.

## Boundaries

- Gate compliance is non-negotiable: no duration above 300ms, no scale from nothing, transform/opacity only.
- Do NOT add entrances to any surface not listed here — the vault list, generator output, and 2FA chooser were explicitly rejected by the gate (100+/day, data the user reads, and below leverage bar respectively).
- Reduced motion: the global block from plan 002 collapses all of these to instant appear — correct for entrances; do not add local overrides.
- If any cited location doesn't match, STOP and report.

## Verification

- **Mechanical**: `npm run build`; `rg 'fade-in-up|shell-enter|route-stage-in' webapp/src/styles` shows exactly one user each.
- **Feel check** (`npm run dev`):
  - Navigate vault → TOTP → settings: each page settles in with a 6px rise over ~180ms — readable but easy to miss on a second pass (that is the bar). Navigate rapidly: no lag sensation, no stacking of entrances.
  - Unlock the vault: the auth card leaves and the shell arrives with a single confident 280ms settle — no teleport, no double motion. Lock again → auth frame rises 8px over 280ms.
  - Log Center → open the settings popover: it drops from its trigger like the sort menu, scaled from the top-right.
  - Settings → switch categories: the panel content fades in ~180ms rather than teleporting.
  - Mobile emulation → vault filter: the chevron rotates through 180°, matching the sidebar chevron's glide.
  - Rendering panel → reduced motion: every one of these becomes an instant appear; nothing moves.
- **Done when**: all four orphaned keyframes (`route-stage-in`, `shell-enter`, `fade-in-up`, plus `menu-in` reused) have exactly one live usage; every new entrance respects its frequency tier.
