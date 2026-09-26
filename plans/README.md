# Motion audit plans — NodeWarden webapp

Audited and planned at commit `7889cfd` (worktree `modern-ui`) by the `improve-animations` and `find-animation-opportunities` skills. 19 corrective findings + 6 gated opportunities → 7 plans → 7 upstream-able PRs.

Each plan is self-contained: exact file paths, current-code excerpts, exact target values (tokens only), ordered steps with commit boundaries, hard scope boundaries, and a feel-check verification section. Executors need zero context from the audit conversation.

## Plans and PR mapping

| Plan | PR | Upstream commit type | Findings covered | Status |
|---|---|---|---|---|
| [001](001-subtract-decorative-motion.md) | A — `chore(webapp): remove decorative motion from high-frequency surfaces` | chore, pure subtraction | 1 (detail cascade), 5 (decorative lifts), 12 (dead layer), 13 (row press — optional commit 4) | TODO |
| [002](002-reduced-motion-and-hover-gating.md) | B — `fix(webapp): scope reduced-motion handling; gate hover motion to hover-capable pointers` | fix, a11y | 3 (reduced-motion nuke), 4 (hover gating) | TODO |
| [003](003-compositing-performance.md) | C — `perf(webapp): composite-friendly transitions` | perf | 2 (`transition: all`), 11 (layout/paint animations), 18 (virtualization spacers — optional commit 3, abandon on jitter) | TODO |
| [004](004-overlay-lifecycle.md) | D — `fix(webapp): interruptible overlay lifecycle` | fix | 8 (toast lifecycle), 10 (menu/dialog interruptibility + ConfirmDialog timer) | TODO |
| [005](005-token-consolidation.md) | E — `refactor(webapp): consolidate motion tokens and keyframes` | refactor, zero visual change | 6 (token bypasses), 17 (stray keyframes) | TODO |
| [006](006-motion-families.md) | F — `style(webapp): unify motion families, transform origins, and press feedback` | style | 7 (entrance/exit curves), 9 (mobile bounce — drop-able commit 2), 14 (origins), 15 (press feedback), 16 (stagger), 19 (TOTP wrap) | TODO |
| [007](007-wire-orphaned-keyframes.md) | G — `feat(webapp): wire prepared entrance animations` | feat, additive | Opportunities 1 (route stage — drop-able commit 1), 2 (unlock handoff), 3 (log popover), 4 (settings panel), 6 (filter chevron); opportunity 5 (toast exit) lives in plan 004 | TODO |

## Recommended execution order

**001 → 005 → 002 → 003 → 004 → 006 → 007**

Dependencies (why this order):

- **001 first**: everything else builds on the reduced rule set. 005 must not tokenize rules 001 deletes; 002's hover-gate list and 003's transition lists assume 001's deletions are done.
- **005 second**: pure consolidation (zero visual change) so every later plan writes against the final token set. Plans 002/003/004 can technically run in any order after 001, but doing 005 first avoids re-touching durations.
- **004 before 006/007**: 006 fixes curves on overlays whose mechanics 004 changes; 007's log-popover wiring adopts whatever pattern 004 established for popovers.
- **006 before 007**: 007 wires entrances using the family rules 006 documents, and deletes no tokens.
- Plans 002 and 003 are mutually independent; run them in either order.

## Taste calls — isolated, drop-able commits

The upstream owner can drop these without touching the rest of their plan:

- **001 commit 4** — vault-row `:active` press feedback (the two audits split; recommended: include, matching the `.btn` precedent).
- **003 commit 3** — virtualization spacer refactor (recommended: attempt last, abandon on any scroll jitter; the team previously fought jitter here).
- **006 commit 2** — removing the mobile `--ease-spring` bounce (recommended: unify to `--ease-out-strong`; if the owner prefers the sheet spring, keep `.mobile-detail-sheet` only).
- **007 commit 1** — route entrance wiring (recommended: wire at 180ms; the alternative — remove `routeAnimationKey` + delete the keyframe — is documented in the plan).

## Deliberate design — do not "fix"

- The `transform: none !important` no-motion zones: `vault.css:259-271`, `management.css:945-951`.
- The vault item list has **no entrance stagger** — correct for a 100+/day surface.
- `.dialog-card` centered origin (modals are exempt from trigger-anchoring); `.nav-layout-menu` bottom-center origin (opens upward).
- TOTP rings driven per-second via `stroke-dashoffset` — the right architecture; only the period-wrap needed a fix (plan 006).
- `grid-template-rows 0fr→1fr` side-subnav accordion — accepted tradeoff, documented in plan 003.

## Executing

Each plan can be run with any agent (e.g. `improve-animations execute <plan>`, or hand it to `/implement` as a ticket). Run `npm run build` as the mechanical gate, and do the plan's feel-check section before marking a plan DONE — update the status column here as plans land. After all plans land, re-run the audit's grep sweeps to reconcile this directory (`improve-animations reconcile`).
