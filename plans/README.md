# Motion audit plans — NodeWarden webapp

Audited and planned at commit `7889cfd` (worktree `modern-ui`) by the `improve-animations` and `find-animation-opportunities` skills. 19 corrective findings + 6 gated opportunities → 8 plans → 7 upstream-able PRs + 1 throwaway decision-support prototype.

Each plan is self-contained: exact file paths, current-code excerpts, exact target values (tokens only), ordered steps with commit boundaries, hard scope boundaries, and a feel-check verification section. Executors need zero context from the audit conversation.

## Plans and PR mapping

| Plan | PR | Upstream commit type | Findings covered | Status |
|---|---|---|---|---|
| [000](000-motion-decision-sandbox.md) | — (throwaway, never shipped) | prototype (decision-support) | settles 006-finding 9 (sheet curve, V0/V1/V2); confirms the landed row press (001-finding 13, landed via `96c31dc`) | **DONE** — decided: V2 spring kept on `.mobile-detail-sheet` only; row press confirmed |
| [001](001-subtract-decorative-motion.md) | A — `chore(webapp): remove decorative motion from high-frequency surfaces` | chore, pure subtraction | 1 (detail cascade), 5 (decorative lifts), 12 (dead layer), 13 (row press — optional commit 4) | **DONE** (all 4 commits, incl. `96c31dc`) |
| [002](002-reduced-motion-and-hover-gating.md) | B — `fix(webapp): scope reduced-motion handling; gate hover motion to hover-capable pointers` | fix, a11y | 3 (reduced-motion nuke), 4 (hover gating) | **DONE** |
| [003](003-compositing-performance.md) | C — `perf(webapp): composite-friendly transitions` | perf | 2 (`transition: all`), 11 (layout/paint animations), 18 (virtualization spacers — optional commit 3, abandon on jitter) | **DONE** (commit 3 skipped, documented) |
| [004](004-overlay-lifecycle.md) | D — `fix(webapp): interruptible overlay lifecycle` | fix | 8 (toast lifecycle), 10 (menu/dialog interruptibility + ConfirmDialog timer) | **DONE** |
| [005](005-token-consolidation.md) | E — `refactor(webapp): consolidate motion tokens and keyframes` | refactor, zero visual change | 6 (token bypasses), 17 (stray keyframes) | **DONE** |
| [006](006-motion-families.md) | F — `style(webapp): unify motion families, transform origins, and press feedback` | style | 7 (entrance/exit curves), 9 (mobile bounce — drop-able commit 2), 14 (origins), 15 (press feedback), 16 (stagger), 19 (TOTP wrap) | **DONE** |
| [007](007-wire-orphaned-keyframes.md) | G — `feat(webapp): wire prepared entrance animations` | feat, additive | Opportunities 1 (route stage — drop-able commit 1), 2 (unlock handoff), 3 (log popover), 4 (settings panel), 6 (filter chevron); opportunity 5 (toast exit) lives in plan 004 | **DONE** |

## Recommended execution order

**Progress so far (HEAD `cd665eb`): 001 ✅ → 005 ✅ → 002 ✅ → 000 (sandbox) ✅. Remaining: 003 → 004 → 006 → 007.**

Dependencies (why this order):

- **001 first**: everything else builds on the reduced rule set. 005 must not tokenize rules 001 deletes; 002's hover-gate list and 003's transition lists assume 001's deletions are done.
- **005 second**: pure consolidation (zero visual change) so every later plan writes against the final token set. Plans 002/003/004 can technically run in any order after 001, but doing 005 first avoids re-touching durations.
- **000 (decision sandbox)**: **DONE** — built against compiled `dist/` CSS (001/002/005 landed), outcomes recorded below and folded into plan 006 commit 2. The sandbox page stays at `prototype/motion-sandbox/` (untracked) as the decision's primary source.
- **004 before 006/007**: 006 fixes curves on overlays whose mechanics 004 changes; 007's log-popover wiring adopts whatever pattern 004 established for popovers.
- **006 before 007**: 007 wires entrances using the family rules 006 documents, and deletes no tokens.
- Plans 002 and 003 are mutually independent; run them in either order.

## Taste calls — isolated, drop-able commits

The upstream owner can drop these without touching the rest of their plan:

- **001 commit 4** — vault-row `:active` press feedback — **landed** (`96c31dc`) and **confirmed by plan 000** (keep P1 as landed); upstream can still drop this commit independently.
- **003 commit 3** — virtualization spacer refactor (recommended: attempt last, abandon on any scroll jitter; the team previously fought jitter here).
- **006 commit 2** — mobile motion unification — **decided by plan 000 (sandbox)**: keep `--ease-spring` on `.mobile-detail-sheet` only; tab, FAB, and `.mobile-sidebar-sheet` unify to crisp; `--ease-out-expo` deleted, `--ease-spring` kept. Plan 006 carries the revised target — no further input needed.
- **007 commit 1** — route entrance wiring (recommended: wire at 180ms; the alternative — remove `routeAnimationKey` + delete the keyframe — is documented in the plan).

## Deliberate design — do not "fix"

- The `transform: none !important` no-motion zones: `vault.css:259-271`, `management.css:945-951`.
- The vault item list has **no entrance stagger** — correct for a 100+/day surface.
- `.dialog-card` centered origin (modals are exempt from trigger-anchoring); `.nav-layout-menu` bottom-center origin (opens upward).
- TOTP rings driven per-second via `stroke-dashoffset` — the right architecture; only the period-wrap needed a fix (plan 006).
- `grid-template-rows 0fr→1fr` side-subnav accordion — accepted tradeoff, documented in plan 003.

## Executing

Each plan can be run with any agent (e.g. `improve-animations execute <plan>`, or hand it to `/implement` as a ticket). Run `npm run build` as the mechanical gate, and do the plan's feel-check section before marking a plan DONE — update the status column here as plans land. After all plans land, re-run the audit's grep sweeps to reconcile this directory (`improve-animations reconcile`).

## Execution record (2026-09-26, worktree `modern-ui`)

All seven plans executed in the recommended order (001 → 005 → 002 → 003 → 004 → 006 → 007), one commit per plan-commit boundary, `npm run build` + `tsc --noEmit` green at every landing. Post-landing reconcile sweep is clean: no `transition: all`, no spring/expo/bounce tokens, no raw off-scale durations beyond the documented set, one spin keyframe, all keyframes in motion.css (except the necessarily-inline `boot-shimmer`), each wired keyframe with exactly one live user.

Documented exceptions (deliberate, not drift):

- **003 commit 3 (virtualization spacers) skipped** — optional by the plan; its abandon-on-jitter protocol requires manual scroll verification on a 500+ item vault that an agent session cannot perform responsibly. Stays available as a follow-up.
- **002's `@media (hover: none)` block is empty by design** — plan 001 had already removed every decorative transform hover; the block remains as the registration point and documents why the three non-motion survivors (positioning re-asserts, show-state centering, no-motion resets) must not be gated.
- **140ms durations remain** (help-bubble, log-config opacity, domain-rule fade) — off-scale by 40ms from both neighboring tokens, outside the 005 snap table; swapping would breach the zero-visual-change boundary.
- **`ease-in-out` remains on infinite shimmer loops** (skeleton/boot) — no token equivalent; swapping would alter loop feel.
- **Plan 000 coordination note (006 commit 2)**: no recorded sandbox decision existed, so the recommended crisp option was applied and `--ease-spring`/`--ease-out-expo` were deleted.
