# 004 — Interruptible overlay lifecycle (toasts, menus, dialogs)

- **Status**: TODO
- **Commit**: 7889cfd
- **Severity**: MEDIUM
- **Category**: Interruptibility (audit findings 8, 10)
- **Estimated scope**: 7 files, ~90 lines
- **PR**: D — `fix(webapp): interruptible overlay lifecycle (toasts, menus, dialogs)`

## Problem

Three overlay families use mount-time keyframes for entry but instant unmount for exit — the exact anti-pattern for rapidly retriggered UI. CSS transitions retarget mid-animation; keyframes restart from zero.

**Finding 8 — toasts** (tens/day; copy confirmations): enter animated, exit in one frame; the lifetime is hard-coded twice and can desync.

```css
/* webapp/src/styles/overlays.css:215, 260-264 — current */
.toast-item { … animation: toast-in 240ms var(--ease-out-strong) both; }
.toast-progress { … animation: toast-life 4.5s linear forwards; }
```

```ts
/* webapp/src/hooks/useToastManager.ts:11-17 — current */
function pushToast(type, text) {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  setToasts((prev) => [...prev.slice(-3), { id, type, text }]);
  window.setTimeout(() => { setToasts((prev) => prev.filter((toast) => toast.id !== id)); }, 4500);
}
```

```tsx
/* webapp/src/components/ToastHost.tsx:12-13 — current (unmounts with no exit) */
{toasts.map((toast) => (<li key={toast.id} className={`toast-item ${toast.type}`}> … ))}
```

**Finding 10 — menus**: entry is a mount-time keyframe; close is instant unmount; toggling mid-entry pops.

```tsx
/* webapp/src/components/vault/VaultListPanel.tsx:239, :276 — current */
{mobileFilterOpen === key && (<div className="sort-menu …"> … )}
{props.createMenuOpen && (<div className="create-menu"> … )}
```

```css
/* vault.css:382, management.css:1583, shell.css:325 — current */
.sort-menu { … animation: menu-in 190ms var(--ease-out-strong) both; }  /* same pattern for .create-menu, .nav-layout-menu */
```

**Finding 10 (dialogs) — ConfirmDialog**: reopen within the 240ms closing window flashes a full re-entry; the JS unmount timer (240ms) duplicates the CSS duration (220ms) and desyncs silently; chained confirms (same dialog, new message) get no entry at all.

```ts
/* webapp/src/components/ConfirmDialog.tsx:97-111 — current */
const timer = window.setTimeout(() => { setPresent(false); setClosing(false); }, 240);
```

## Target

All three families: element stays mounted while animating, transitions retarget, one source of truth per duration.

```ts
/* useToastManager.ts — target shape */
const TOAST_LIFE_MS = 4500;   // single source of truth; CSS progress bar must match 4.5s
const TOAST_EXIT_MS = 180;    // equals --dur-fast used by the .closing CSS below
type ManagedToast = ToastMessage & { closing: boolean };
// pushToast: add with closing=false; schedule markClosing(id) at TOAST_LIFE_MS - TOAST_EXIT_MS,
// then remove(id) at TOAST_LIFE_MS.
// removeToast(id) (manual close): markClosing(id) now, remove after TOAST_EXIT_MS.
// Guard double-scheduling by id.
```

```css
/* overlays.css — target */
.toast-item.closing { animation: fade-out var(--dur-fast) var(--ease-out-soft) both; }
/* (fade-out already exists in motion.css:52-55: opacity 1→0, translateY 0→-6px, scale 1→0.98) */
```

```css
/* menus — target pattern (the codebase's own .mobile-sidebar-sheet approach, responsive.css:276-298) */
.sort-menu, .create-menu, .nav-layout-menu {
  /* keep existing layout/origin rules; replace `animation: menu-in …` with: */
  opacity: 0; visibility: hidden; pointer-events: none;
  transform: translateY(-4px) scale(0.98);
  transition: opacity var(--dur-quick) var(--ease-out-strong),
    transform var(--dur-quick) var(--ease-out-strong),
    visibility var(--dur-quick);
}
.sort-menu.open, .create-menu.open, .nav-layout-menu.open {
  opacity: 1; visibility: visible; pointer-events: auto; transform: none;
}
```

```css
/* dialogs — target: transitions + @starting-style instead of keyframes (overlays.css) */
.dialog-mask { /* keep fade-in animation for the mask (backdrop fade is fine) */ }
.dialog-card {
  opacity: 1; transform: none;
  transition: opacity var(--dur-medium) var(--ease-out-strong),
    transform var(--dur-medium) var(--ease-out-strong);
}
@starting-style { .dialog-card { opacity: 0; transform: translateY(12px) scale(0.97); } }
.dialog-card.closing {
  opacity: 0; transform: translateY(8px) scale(0.97);
  transition: opacity var(--dur-medium) var(--ease-out-soft),
    transform var(--dur-medium) var(--ease-out-soft);
}
```

## Repo conventions to follow

- Persistent-element + `.open` + transitions exemplar: `.mobile-sidebar-sheet` (`responsive.css:276-298`).
- Exit-phase exemplar to imitate: ConfirmDialog's existing `.closing` class mechanics.
- `@starting-style` is acceptable: the webapp already requires color-mix, backdrop-filter, and dvh.

## Steps

Commit 1 — toasts:
1. `useToastManager.ts`: restructure to the target shape above (closing phase before removal, single constants). `pushToast` marks closing at 4320ms and removes at 4500ms; `removeToast` runs the closing phase too. Export the type change `ToastMessage & { closing: boolean }` or map to `closingIds: string[]` in state — pick the smaller diff, keep the exported API (`toasts`, `pushToast`, `removeToast`) identical for callers.
2. `ToastHost.tsx`: add `closing` to the item className (`toast-item ${type}${toast.closing ? ' closing' : ''}`). No other JSX change.
3. `overlays.css`: add the `.toast-item.closing` rule; keep `toast-life 4.5s linear` (matches `TOAST_LIFE_MS`; add a comment `/* keep in sync with TOAST_LIFE_MS in useToastManager.ts */` at both sites).
4. Accepted limitation (do NOT solve): stack eviction via `slice(-3)` still removes without animation when a 4th toast arrives in a burst.

Commit 2 — menus:
5. `vault.css:375-383`, `management.css:1576-1584`, `shell.css:319-326`: replace the `animation: menu-in …` declaration with the persistent target rules above. Keep each menu's existing `transform-origin` and positioning unchanged. `menu-in` keyframe may become unused → `rg 'menu-in' webapp/src` and delete the keyframe from motion.css only if fully unreferenced.
6. `VaultListPanel.tsx:239` and `:276`: render the menu elements unconditionally (keep the exact same DOM content), drive visibility with className: `${mobileFilterOpen === key ? 'open' : ''}` / `${props.createMenuOpen ? 'open' : ''}`.
7. Find `.nav-layout-menu`'s mount site the same way (`rg 'nav-layout-menu' webapp/src/components`) and apply the same conditional-class conversion.
8. Outside-click dismissal handlers already flip the state; with the element persistent, confirm clicking outside still closes (state-driven class) and that focus/tab order is unchanged (visibility:hidden removes it from the a11y tree when closed — verify no keyboard trap).
9. `.mobile-fab-wrap .create-menu` (responsive.css:490-495) re-anchors the menu — it inherits the new transition; verify no positioning breakage.

Commit 3 — dialogs:
10. `overlays.css`: replace `dialog-in` keyframe usage with the transition + `@starting-style` target; keep `.dialog-mask` entrance and add `.dialog-mask.closing` unchanged behavior (mask can keep its `fade-in`/`fade-out` keyframes — it never retargets mid-flight; only the card needs transitions). Delete the `dialog-in`/`dialog-out` keyframes only if `rg 'dialog-in|dialog-out' webapp/src` is clean afterwards.
11. `ConfirmDialog.tsx`: keep the `closing` class mechanism and its 240ms timer (now only a safety fallback), but also add an `onTransitionend` handler on the card (for `opacity`) that completes dismissal earlier than the timer when possible. Reopen-during-close and chained confirms now retarget instead of flashing — confirm via feel check.

## Boundaries

- Do NOT touch toast visual design, stacking order, or the `slice(-3)` cap.
- Do NOT change any overlay's z-index, positioning, or transform-origin (plan 006 handles origins).
- Menu TSX changes are class-conditional only — no new elements, no reorder of DOM inside the menus.
- If a cited location doesn't match (or plans 001-003 already changed line numbers), STOP and report.

## Verification

- **Mechanical**: `npm run build` succeeds; `rg 'animation:\s*(toast-in|menu-in|dialog-in)' webapp/src/styles` returns nothing.
- **Feel check** (`npm run dev`):
  - Toasts: copy a username → toast enters, progress bar drains the full 4.5s, exit fades/rises ~180ms; click copy rapidly 5× → toasts stack and each exits smoothly; pressing the X closes with the same fade, never a pop.
  - Menus: open the sort menu and close it within 80ms (rapid toggle) → it reverses from its current state, never restarts or pops; keyboard through it when open; when closed it is not focusable.
  - Dialogs: open delete-confirm on an item, cancel, immediately reopen → no opacity flash from zero; run two chained confirms (same dialog, new text) → second swap is calm, not teleporting.
  - DevTools Animations panel at 10%: exits are visible and symmetric with entrances (enter out-strong, exit out-soft).
  - Reduced motion (Rendering panel): everything appears instantly but stays *visible* — nothing vanishes early.
- **Done when**: rapid toggling never restarts an animation from zero; every overlay exit is animated; no duration literal exists in more than one place.
