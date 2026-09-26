# 002 — Scope reduced-motion handling and gate hover motion for touch

- **Status**: DONE (commit cd665eb on `modern-ui`; hover-gate block empty by design after 001). Live-verified: the reduced-motion whitelist and functional-indicator overrides survive minification into the bundle; note the empty `@media (hover: none)` block is dropped by the CSS minifier (nothing to apply — the registration point lives in source where new transform-hovers get added)
- **Commit**: 7889cfd
- **Severity**: HIGH
- **Category**: Accessibility (audit findings 3, 4)
- **Estimated scope**: 3 files, ~45 lines
- **PR**: B — `fix(webapp): scope reduced-motion handling; gate hover motion to hover-capable pointers`

## Problem

**Finding 3 — the global reduced-motion block nukes all feedback**, not just movement. It forces `animation-duration: 1ms` + `animation-iteration-count: 1` + `transition-duration: 1ms` on every element, so reduced-motion users lose: every hover/focus color transition (snaps), the theme cross-fade (`base.css:28`), **all loading spinners** (`btn-icon-spin`, `generator-spinner`, skeleton pulse/shimmer — the "work in progress" affordance freezes), and the toast lifetime bar (`overlays.css:260-264`: bar drains in 1ms while the toast stays 4.5s with no cue). Playbook: reduced motion means fewer and gentler animations, not zero.

```css
/* webapp/src/styles/motion.css:87-96 — current */
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 1ms !important;
    animation-iteration-count: 1 !important;
    scroll-behavior: auto !important;
    transition-duration: 1ms !important;
  }
}
```

```css
/* webapp/src/styles/generator.css:32 — current */
@media (prefers-reduced-motion: reduce) { .generator-toggle > span, .generator-toggle > span::after { transition: none; }.generator-spinner { animation: none; } }
```

**Finding 4 — no hover-capability gating anywhere.** `rg '(hover: hover)|pointer: fine' webapp/src` returns zero matches; every `:hover` transform fires as sticky false-hover on first tap on touch devices. After plan 001's deletions, the surviving touch-exposed transform hovers are: theme-switch icons (`shell.css:157`, `scale(1.08)`), auth links (`forms.css:281`, `translateX(2px)`), TOTP scan close (`vault.css:1007`, `scale(1.04)`), domain-rule remove (`management.css:2133`, `scale(1.04)`), backup-help bubble slide (`management.css:144`), and any others the sweep in step 8 finds.

## Target

Reduced motion drops movement and decorative loops but keeps comprehension-aiding color/opacity feedback and functional progress indicators. Touch devices get no transform hovers.

```css
/* webapp/src/styles/motion.css:87-96 — replaced with */
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    /* Entrances and decorative loops end instantly; color/opacity feedback
       keeps its normal duration (transition-property whitelist below). */
    animation-duration: 1ms !important;
    animation-iteration-count: 1 !important;
    /* Movement is dropped by excluding transform from every transition;
       color/opacity/visibility/shadow feedback stays legible. */
    transition-property: color, background-color, border-color, opacity,
      box-shadow, visibility, stroke, stroke-dashoffset, fill !important;
    scroll-behavior: auto !important;
  }
  /* Functional indicators keep moving so state stays legible */
  .btn-icon-spin { animation: spin 2s linear infinite !important; }
  .skeleton-card, .skeleton-list-item { animation: skeleton-pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite !important; }
  .toast-progress { animation: toast-life 4.5s linear forwards !important; }
  /* Shimmer overlays (decorative) stop; the pulse above carries the loading state */
}

@media (hover: none) {
  /* Touch devices: never apply transform hovers (sticky-tap false hover).
     This block is the single place new transform-hovers must be registered. */
  …transform: none !important; …
}
```

```css
/* webapp/src/styles/generator.css:32 — target */
@media (prefers-reduced-motion: reduce) { .generator-toggle > span, .generator-toggle > span::after { transition: none; }.generator-spinner { animation: generator-spin 2s linear infinite; } }
```

## Repo conventions to follow

- Targeted reduced-motion exemplar: `auth.css:429-434` (decorative stars/astronaut → `animation: none` while everything else keeps running).
- Exemplars of correct state legibility: `skeleton-pulse` (opacity only), `toast-life` (progress).

## Steps

Commit 1 — reduced-motion scoping:
1. Replace the block at `motion.css:87-96` with the target block above.
2. Edit `generator.css:32`: change `.generator-spinner { animation: none; }` to `.generator-spinner { animation: generator-spin 2s linear infinite; }` (leave the toggle `transition: none` lines — knob movement is exactly what reduced motion should drop). The 2s override in generator.css is unnecessary once step 1's global `.btn-icon-spin` whitelist approach exists but `generator-spinner` is a different class — keep this local rule.
3. Confirm `auth.css:429-434` still works alongside the new block (it only strengthens it — decorative loops already end via the global rule; the local rule keeps the 404 stars fully off).
4. Check the theme cross-fade (`base.css:28`) now survives under reduced motion: `transition-property` whitelist includes `background-color` and `color` → dark/light switch cross-fades gently instead of flashing.

Commit 2 — hover gating:
5. Add the `@media (hover: none)` block to the end of `motion.css` (see target).
6. Populate it with the surviving transform hovers. Sweep first: `rg -n ':hover' webapp/src/styles -A 3 | rg -B 3 'transform'` — every hit is either (a) already deleted by plan 001, or (b) belongs in this block.
7. Known members after plan 001: `.theme-switch:hover .theme-switch-icon-sun, .theme-switch-icon-moon` (verify exact child selectors at `shell.css:157`), `.auth-link-btn:hover` (`forms.css:281`), `.totp-scan-close:hover` (`vault.css:1007`), `.domain-rule-remove-btn:hover` (`management.css:2133` — verify class name), `.backup-help-wrap:hover .backup-help-bubble` (`management.css:144` — gate the bubble's transform only if the hover-driven position is the trigger; `:focus-within`/`.open` behavior must remain untouched).
8. Each entry in the block: `transform: none !important;` — color/background hover feedback is deliberately NOT gated.

## Boundaries

- Do NOT remove color/opacity feedback anywhere — only movement.
- Do NOT gate `:focus-visible`/`:focus-within` styles — keyboard/touch focus paths must behave identically.
- Do NOT change the `1ms` animation-duration approach for entrances (instant appear is correct for reduced motion).
- Do not touch keyframe definitions (plan 005) or menu/dialog mechanics (plan 004).
- If cited lines no longer match, STOP and report.

## Verification

- **Mechanical**: `npm run build` succeeds.
- **Feel check**: DevTools → Rendering panel:
  - Toggle **Emulate CSS prefers-reduced-motion: reduce**: (1) spinner buttons (`btn-icon-spin`) and the SSH generator spinner keep rotating, slower; (2) skeleton loaders keep pulsing; (3) a toast's progress bar drains over the full 4.5s; (4) dialog opens instantly (no motion) — acceptable; (5) theme switch cross-fades; (6) hovering a button still fades color in ~180ms.
  - Toggle **Emulate a mobile device with touch** (DevTools device mode): (1) tapping the theme-switch icons never leaves a stuck scaled state; (2) first tap on any button shows no pre-transform; (3) color hovers still work.
- **Done when**: under reduced motion nothing translates/scales but color feedback and functional indicators survive; under `(hover: none)` no `transform` hovers apply.
