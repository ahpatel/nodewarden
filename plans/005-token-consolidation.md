# 005 — Consolidate motion tokens and keyframes

- **Status**: TODO
- **Commit**: 7889cfd
- **Severity**: MEDIUM
- **Category**: Cohesion & tokens (audit findings 6, 17)
- **Estimated scope**: ~12 files, ~90 line edits, zero visual change
- **PR**: E — `refactor(webapp): consolidate motion tokens and keyframes`

## Problem

The token system (`webapp/src/styles/tokens.css:35-46`) exists but is widely bypassed. A full inventory (verified at 7889cfd):

**Durations off-scale:**
- `220ms` ×13 (shell.css:162,265,267,375,376; overlays.css:56,60; management.css:1610; vault.css:567,722,733,754,1094) — an undeclared 7th duration, exactly between `--dur-fast` (180) and `--dur-medium` (240)
- `190ms` ×4 (shell.css:252,325; vault.css:382; management.css:1583 — the menu family; Δ10ms from `--dur-fast`)
- `200ms` ×5 (responsive.css:288,290,527,529; vault.css:969)
- `260ms` ×2 (responsive.css:289; vault.css:969)
- `240ms`/`280ms`/`180ms`/`120ms`/`80ms` literals whose exact values ARE tokens (overlays.css:16,215; vault.css:577,713,797,811; responsive.css:248,475,259; management.css:2024; overlays.css:243)
- `0.15s`/`150ms` ×9+16 — Tailwind's bare `transition` utility bakes 150ms + `cubic-bezier(0.4,0,0.2,1)` (byte-identical to `--ease-smooth`) into 16 rules incl. `.list-item` (vault.css:442), `.topbar` (shell.css:12), `.user-chip` (shell.css:170), `.search-input` (vault.css:54), `.side-link` (shell.css:195) and more

**Easings off-system:** `ease` keyword ×23 property instances across 10 declarations (management.css:124,233,902,1019,1759; password-security.css:15; generator.css:22,24; overlays.css:243; vault.css:969) — hand-typed near-matches of `--ease-smooth`/`--ease-out-soft`.

**Dead tokens:** `--ease-bounce` (tokens.css:40) — zero uses. `--dur-slow` (tokens.css:46) — zero uses. `--dur-panel` (tokens.css:45) — zero uses while its exact value (280ms) is hardcoded.

**Finding 17 — stray/duplicate keyframes:** four spin systems (`spin` motion.css:77; `password-security-spin` password-security.css:50; `generator-spin` generator.css:29; `not-found-astronaut-spin` auth.css:65); two shimmer systems (`shimmer` motion.css:67 [likely already deleted by plan 003] vs `loading-shimmer` styles.css:231); one-offs (`not-found-star-fall` auth.css:49, `boot-shimmer` index.html:82) living outside `motion.css`, the designated home. `pulse-glow` (motion.css:72-75) is dead AND carries a hardcoded light-mode blue that breaks in dark mode.

**Keep (do NOT delete):** `fade-in-up`, `shell-enter`, `route-stage-in` — currently unused but wired by plan 007.

## Target

Every duration/curve in `webapp/src` (excluding token definitions, loading-loop speeds, and stagger-delay utilities handled by plan 006) resolves to a token. One spin keyframe, one shimmer keyframe, all keyframes in motion.css.

| Current | Becomes | Note |
|---|---|---|
| `220ms` | `var(--dur-medium)` | 20ms slower, imperceptible |
| `190ms` | `var(--dur-fast)` | menu family; Δ10ms |
| `200ms` | `var(--dur-medium)` (sheet opacity/visibility) / `var(--dur-fast)` (totp stroke) | by context |
| `260ms` | `var(--dur-medium)` | |
| `240ms` literal | `var(--dur-medium)` | |
| `280ms` literal | `var(--dur-panel)` | finally uses the token |
| `180ms` literal | `var(--dur-fast)` | |
| `120ms` literal | `var(--dur-quick)` | |
| `80ms` literal | `var(--dur-instant)` | |
| `160ms`/`0.15s`/bare `transition` | `var(--dur-fast)` + explicit property list | see step 3 |
| `ease` keyword | `var(--ease-smooth)` | color/opacity contexts only |
| `--ease-bounce`, `--dur-slow` | deleted | zero uses; `--dur-slow`'s job is gone (stagger trimmed by 006 to ≤ `--dur-panel`) |

## Repo conventions to follow

- Token definitions live in `tokens.css:35-46` only.
- Fully-tokened exemplar: `base.css:28` (`transition: background-color var(--dur-medium) var(--ease-smooth), color …`).

## Steps

1. **Snap exact-value literals to tokens** per the table above, in: shell.css, overlays.css, vault.css, management.css, responsive.css, forms.css. Keep the curve part unchanged in this step (only durations).
2. **Snap near-miss values** (`220ms`→`var(--dur-medium)`, `190ms`→`var(--dur-fast)`, `260ms`→`var(--dur-medium)`, `160ms`→`var(--dur-fast)`).
3. **Replace the Tailwind bare `transition` in `@apply` lists** (16 rules; sweep with `rg '@apply .* transition' webapp/src/styles`) with an explicit transition on each rule. Default replacement when the rule only changes colors on hover/focus:
   ```css
   transition: background-color var(--dur-fast) var(--ease-smooth),
     border-color var(--dur-fast) var(--ease-smooth),
     color var(--dur-fast) var(--ease-smooth),
     box-shadow var(--dur-fast) var(--ease-smooth),
     opacity var(--dur-fast) var(--ease-smooth);
   ```
   For `.list-item` (vault.css:442) add `transform var(--dur-fast) var(--ease-out-soft)` only if plan 001's optional row-press commit landed.
4. **Normalize `ease` keywords**: replace with `var(--ease-smooth)` in color/background/border/opacity transition contexts (management.css:233,902,1019; overlays.css:243; generator.css:22 stepper background; password-security.css:15 border/shadow legs). Leave transform legs alone if plan 006 will realign them (generator toggle knob, password-security-metric transform) — do not introduce new curves here.
5. **TOTP ring** (vault.css:969): `transition: stroke-dashoffset var(--dur-medium) linear, stroke var(--dur-fast) var(--ease-smooth);` — keep `linear` (constant countdown motion).
6. **Dead tokens**: delete `--ease-bounce` and `--dur-slow` from tokens.css. Do NOT delete `--ease-spring`/`--ease-out-expo` (plan 006 removes their usages and deletes them).
7. **Spin consolidation**: point `.spin`/spinner classes at the single `spin` keyframe (motion.css) with their existing durations: password-security.css:49-50 (delete `password-security-spin`), generator.css:28 (use `spin 0.9s`; delete `generator-spin` at :29), auth.css astronaut (use `spin` with its 5s duration; delete `not-found-astronaut-spin` at :65).
8. **Keyframe home**: move `loading-shimmer` (styles.css:231) and `not-found-star-fall` (auth.css:49) into motion.css unchanged (names kept). Delete `pulse-glow` (motion.css:72-75) — dead and color-broken. Check `index.html:82` `boot-shimmer`: if it duplicates `loading-shimmer`, point it at motion.css's copy instead of keeping two.
9. **Sweep check**: `rg -n '\b\d{3}ms\b|\.15s|\bease\b' webapp/src/styles --glob '*.css'` must now return only: token definitions in tokens.css, loop/functional durations (0.9s, 1.25s, 1.5s, 2s, 4.5s, 5s, 9s), the `skeleton.css:6` pulse bezier, and stagger-delay utilities (vault.css:472-513, handled by 006).

## Boundaries

- Zero intended visual change: if a swap would alter feel (e.g. a duration you cannot snap within 20ms), leave it and note it in the PR description instead of forcing it.
- Do NOT touch `--ease-spring`/`--ease-out-expo` usages or delete those tokens (plan 006).
- Do NOT delete `fade-in-up`, `shell-enter`, `route-stage-in` (plan 007 wires them).
- Do NOT reformat, reorder, or "clean up" unrelated rules — token swaps only.
- If a cited line no longer matches (plans 001-004 have landed and shifted lines), re-locate by the quoted values, not line numbers; if a value is gone entirely, skip it.

## Verification

- **Mechanical**: `npm run build` succeeds; the step-9 sweep returns only the exempted categories.
- **Feel check** (`npm run dev`): hover states, theme switch, dialogs, menus, toasts all feel identical to before this plan — spot-check the four highest-traffic paths (vault row hover, copy-button press, dialog open/close, theme toggle). Any perceptible change is a failure of this plan.
- **Done when**: every non-exempt duration/curve in webapp/src/styles resolves to a token; one spin keyframe; one shimmer keyframe; no keyframes defined outside motion.css (except `boot-shimmer` if index.html's inline context requires it — note it).
