# 006 — Unify motion families, origins, and press feedback

- **Status**: DONE (commits 4b2054d, b8bc168, 6e464c8, b03326e, 992ec1d, 1472409 on `modern-ui`; commit 2 initially landed crisp, then reconciled to plan 000's recorded decision — `--ease-spring` restored on `.mobile-detail-sheet`'s transform leg only)
- **Commit**: 7889cfd
- **Severity**: MEDIUM (7, 9, 14, 15, 16), LOW (19)
- **Category**: Cohesion & tokens / Physicality / Interruptibility (audit findings 7, 9, 14, 15, 16, 19)
- **Estimated scope**: 6 files, ~70 lines
- **PR**: F — `style(webapp): unify motion families, transform origins, and press feedback`

## Problem

Sibling surfaces disagree, origins contradict anchors, and press timing is symmetric. All verified at 7889cfd (line numbers may have shifted after plans 001-005 — re-locate by quoted code).

**Finding 7 — "surface appears" is split three ways by file, not by role.** Dialogs/menus/toasts enter with `--ease-out-strong`; detail cards with `--ease-out-soft`; masks with `--ease-smooth` (an in-out curve with a slow start), so backdrops lag their cards. Exits use `--ease-smooth` — exits must ease out, not in-out:

```css
/* overlays.css:5 */    .dialog-mask { animation: fade-in var(--dur-medium) var(--ease-smooth) both; … }
/* overlays.css:56,60 */ .dialog-mask.closing { animation: fade-out … var(--ease-smooth) both; } .dialog-card.closing { … var(--ease-smooth) both; }
/* shell.css:375 */    .mobile-sidebar-mask { transition: opacity 220ms var(--ease-smooth), visibility … var(--ease-smooth); }
```

**Finding 9 — mobile bounce in a crisp security app** (`--ease-spring: cubic-bezier(0.34, 1.56, 0.64, 1)` overshoots past 1.0 on the core mobile gestures; desktop equivalents never bounce):

```css
/* responsive.css:528 */ .mobile-detail-sheet  { transition: … transform 280ms var(--ease-spring), … }   /* every vault item open on mobile */
/* responsive.css:289 */ .mobile-sidebar-sheet { transition: … transform 260ms var(--ease-spring), … }
/* responsive.css:248 */ .mobile-tab          { transition: transform 180ms var(--ease-spring), … }
/* responsive.css:475 */ .mobile-fab-trigger  { transition: transform 180ms var(--ease-spring), … }
/* plus --ease-out-expo (near-duplicate of --ease-out-strong) on opacity/visibility legs at 288,290,527,529 */
```

**Finding 14 — transform-origins contradict anchors:**

```css
/* management.css:1582 */ .create-menu { … top: calc(100% + 6px); transform-origin: bottom left; }  /* opens BELOW trigger but scales from the far edge */
/* responsive.css:286 */ .mobile-sidebar-sheet { … transform: translate3d(0,12px,0) scale(0.97); }     /* no origin → center default, but drops from the topbar */
/* responsive.css:525 */ .mobile-detail-sheet  { … transform: translate3d(0,20px,0); }                 /* same */
/* overlays.css:209 */  .toast-item { … }                                                              /* corner-anchored, center origin */
/* vault.css:381 vs :324 */ .sort-menu { transform-origin: top right; } but mobile instances re-anchor left: 0 → scale from the horizontal far edge
```

**Finding 15 — symmetric press/release and missing icon-button press feedback:**

```css
/* responsive.css:472-484 */ .mobile-fab-trigger { transition: transform 180ms var(--ease-spring), … } .mobile-fab-trigger:active { transform: scale(0.94); }  /* same 180ms both directions */
/* password-security.css:15-17 */ .password-security-metric { transition: … transform 160ms ease; } :active { transform: scale(.99); }  /* symmetric */
/* forms.css:93-122 */ .input-icon-btn, .eye-btn, .password-toggle — hover scales up, no :active rule (cursor grows on press)
```

**Finding 16 — over-long stagger + dead stagger classes:** `stagger-rise 520ms` + delay ladder to 260ms ≈ 780ms choreography (vault.css:467-513); SendsPage detail cards carry dead `stagger-item` classes beaten by `.detail-switch-stage > .card` specificity while their `animation-delay` leaks (SendsPage.tsx:428, 539, 544, 567) — note: if plan 001 deleted the `.detail-switch-stage > .card` rule, the `stagger-item` animation itself may now run there; the class cleanup below still applies.

**Finding 19 — TOTP ring wraps visibly:** at each 30s boundary `stroke-dashoffset` jumps backward by the full circumference and the 260ms→(tokened) transition renders it as a fast reverse sweep instead of a snap.

## Target

Family rules (document once in a comment at the top of motion.css):
- Pop entrances (menus, dialogs, toasts): `--ease-out-strong`
- Panel/sheet entrances: `--ease-out-soft`
- All exits: `--ease-out-soft`
- Color/hover: `--ease-smooth`; constant motion: `linear`
- Press feedback: press leg `--dur-instant` (80ms), release leg `--dur-fast` with `--ease-out-soft` — press snaps, release settles

```css
/* responsive.css — target (commit 2) */
.mobile-tab         { transition: transform var(--dur-fast) var(--ease-out-soft), background-color var(--dur-fast) var(--ease-smooth), color var(--dur-fast) var(--ease-smooth); }
.mobile-fab-trigger { transition: transform var(--dur-fast) var(--ease-out-soft), box-shadow var(--dur-fast) var(--ease-out-soft); }
.mobile-fab-trigger:active { transform: scale(0.96); transition-duration: var(--dur-instant); }
.mobile-sidebar-sheet { … transition: opacity var(--dur-fast) var(--ease-out-soft), transform var(--dur-medium) var(--ease-out-strong), visibility var(--dur-fast); transform-origin: top center; }
.mobile-detail-sheet  { … transition: opacity var(--dur-fast) var(--ease-out-soft), transform var(--dur-panel) var(--ease-spring), visibility var(--dur-fast); transform-origin: top center; }
/* DECIDED (plan 000): the detail sheet KEEPS --ease-spring on its transform leg — swap only the opacity/visibility legs off --ease-out-expo. Tab, FAB, and .mobile-sidebar-sheet get the crisp values above unchanged. */

/* press (commit 3) */
.password-security-metric:active:not(:disabled) { transform: scale(.99); transition-duration: var(--dur-instant); }
.input-icon-btn:active, .eye-btn:active, .password-toggle:active { transform: scale(0.95); transition-duration: var(--dur-instant); }
```

After commit 2, delete `--ease-spring`, `--ease-out-expo` from tokens.css (`rg 'ease-spring|ease-out-expo' webapp/src` must be empty first).

## Repo conventions to follow

- Press exemplar: `.btn` (forms.css:161-169) — hover `--dur-quick`, active `--dur-instant`.
- Chevron exemplar: `.side-group-chevron { transition: transform 190ms var(--ease-out-soft); }` (shell.css:250-253).

## Steps

Commit 1 — entrance/exit family (finding 7):
1. `overlays.css`: mask entrance → `fade-in var(--dur-medium) var(--ease-out-soft)`; dialog/toast/mask exits → `var(--ease-out-soft)` (keep durations as tokened by plan 005).
2. `shell.css` mobile-sidebar-mask: opacity/visibility curves → `var(--ease-out-soft)`.
3. Add the family-rules comment block to the top of motion.css (5 lines, the list above).

Commit 2 (taste call — **DECIDED by plan 000**) — mobile unification (finding 9):
<!-- RECORDED DECISION (plan 000 motion sandbox, felt-tested at 100% + 10% speed, both themes): keep --ease-spring on .mobile-detail-sheet ONLY (V2 won). Tab, FAB, and the sidebar sheet still unify to crisp per the original target. --ease-out-expo is still removed; --ease-spring is KEPT (one live use). Row press (001 commit 4): confirmed keep as landed. -->
4. `responsive.css`: apply the target block above — tab, FAB, and `.mobile-sidebar-sheet` get the crisp curves; `.mobile-detail-sheet` swaps only its opacity/visibility legs to `var(--ease-out-soft)` and keeps `var(--ease-spring)` on the transform leg (decided by plan 000). Then delete `--ease-out-expo` from tokens.css after the grep guard; **keep `--ease-spring`** (one live use).

Commit 3 — press feedback (finding 15):
5. `responsive.css`: FAB per target above. `password-security.css:15-17`: per target. `forms.css`: add `:active` rules for `.input-icon-btn`, `.eye-btn`, `.password-toggle` per target (these are absolute-positioned: the `:active` transform must compose with their positioning — check each rule's base `transform`; `.search-clear-btn` if it still exists post-001 uses `translateY(-50%)` so its active rule is `transform: translateY(-50%) scale(0.95);`).
6. Nav/menu/row pressables without any press cue (`.side-link`, `.side-sub-link`, `.user-chip`, `.tree-btn`, `.sort-menu-item`, `.create-menu-item`, `.org-list-item`): add a **non-transform** cue — one notch stronger background than their hover, e.g. `.side-link:active { background: color-mix(in srgb, var(--primary) 14%, transparent); }` mirroring the existing color-mix hover idiom (see styles.css danger hovers). Match each element's own hover palette.

Commit 4 — origins (finding 14):
7. `management.css:1582`: `.create-menu` → `transform-origin: top left;`. Add `.mobile-fab-wrap .create-menu { transform-origin: bottom right; }` (responsive.css, after :490-495) since that instance opens upward-right; if its `menu-in`/transition slide direction still reads wrong (enters downward when it should rise), add `@keyframes menu-in-up { from { opacity: 0; transform: translateY(6px) scale(0.97); } to { opacity: 1; transform: translateY(0) scale(1); } }` to motion.css and use it there.
8. `overlays.css` `.toast-item`: add `transform-origin: right center;`.
9. `vault.css` mobile filter menus: find the left-anchored instances (`.mobile-vault-filter-menu` region, ~:315-330) and give them `transform-origin: top left;` while right-anchored `.sort-menu` keeps `top right`.

Commit 5 — stagger (finding 16):
10. `vault.css`: `stagger-rise` duration 520ms → `var(--dur-panel)`; delay ladder steps 26ms → 40ms (`stagger-delay-1` 40ms … `stagger-delay-6` 240ms), delete tiers 7-10.
11. `SendsPage.tsx:348`: `stagger-delay-${Math.min(index, 10)}` → `Math.min(index, 6)`.
12. `SendsPage.tsx:428, 539, 544, 567`: remove the dead `stagger-item stagger-delay-0` classes from detail cards.

Commit 6 — TOTP wrap (finding 19):
13. In the components that tick the ring (`VaultPage.tsx:~628`, `TotpCodesPage.tsx:~165`, `VaultDetailView.tsx:~261`): when the new offset is greater than the previous (period wrap), apply it with the transition suppressed — set `el.style.transition = 'none'`, update `strokeDashoffset`, then restore on the next frame (`requestAnimationFrame(() => { el.style.transition = ''; })`). Within-period updates keep the normal transition. If the three call sites share no helper, put a tiny `setRingOffset(el, value)` helper next to one of them and use it at all three.

## Boundaries

- Commit 2 is **decided** (plan 000): spring stays on `.mobile-detail-sheet` only; tab/FAB/sidebar go crisp. No further taste input needed — implement as written.
- Do NOT change durations on the toast/dialog family beyond what plans 004/005 already set — this plan only fixes curves, origins, press, stagger, and the TOTP wrap.
- If cited lines don't match after plans 001-005, re-locate by quoted values; report anything unfindable instead of improvising.

## Verification

- **Mechanical**: `npm run build`; `rg 'ease-out-expo' webapp/src` empty (post commit 2); `rg 'ease-spring' webapp/src` returns exactly the token definition plus its single `.mobile-detail-sheet` use.
- **Feel check** (`npm run dev`, DevTools Animations panel at 10%):
  - Open a dialog: backdrop and card start together; close: both leave promptly (no slow-start linger).
  - Mobile emulation: open a vault item → the sheet rises from the **top edge** with a confident settle, no bounce past rest; bottom tab press snaps down in ~80ms and settles ~180ms; no overshoot on tab switch.
  - Open the create menu (desktop): it scales from its **top-left corner** (its trigger), not the bottom. FAB menu on mobile scales from its bottom-right anchor.
  - Press any icon button (eye toggle, password reveal): it shrinks slightly on press — never grows.
  - Sends page: rows rise in with ≤240ms total delay; last row settles ≈ 520ms after mount, not 780ms.
  - Watch a TOTP code at the 30s rollover: the ring snaps to full, never sweeps backward.
- **Done when**: entrance curve matches surface role at every overlay; no bounce anywhere on mobile; every pressable gives press feedback; the only spring/overshoot left (if any) is `.mobile-detail-sheet` and that was a conscious choice.
