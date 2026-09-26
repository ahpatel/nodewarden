# 000 — Motion decision sandbox (prototype)

- **Status**: DONE — decisions recorded 2026-09-26
- **Commit**: 7889cfd (authored during the parallel 001 execution thread; coordination updated after 001/002/005 landed — see Progress below)
- **Severity**: n/a — decision-support prototype, never shipped
- **Category**: prototyping for the two feel-driven taste calls (001 finding 13, 006 finding 9)
- **Estimated scope**: 3 new files under `prototype/motion-sandbox/` (unbuilt, untracked), ~120 lines
- **PR**: none — throwaway; outcomes are recorded in `plans/README.md` and folded into plans 001/006

## Purpose

Settle the two decisions the audits flagged as unjudgeable from code, with live variants instead of post-hoc drop-able commits:

1. **006 commit 2 (mobile sheet curve)** — which settle curve ships on `.mobile-detail-sheet`: crisp `--ease-out-strong`, a subtle spring, or today's 1.56 overshoot (still live as of `cd665eb`: `responsive.css:516` uses `var(--ease-spring)`).
2. **001 commit 4 (vault-row press feedback)** — already **landed** (`96c31dc`, `.list-item:active { transform: scale(0.98); transition-duration: var(--dur-instant); }` at `vault.css:462`). The sandbox now *confirms the landed press by feel* and, if it reads heavy, tests lighter alternatives — this is a tuning check, not an open decision.

Gate compliance: every variant stays inside the duration budget and transform/opacity only. The comparison **isolates the curve** by holding the duration constant (`var(--dur-panel)`) across all sheet variants.

## Coordination constraints

- **Progress at authoring update: plans 001 (all 4 commits, incl. row press `96c31dc`), 002, 005 are DONE** (HEAD `cd665eb`); 003/004/006/007 pending.
- Execute **before plan 006 commits 2 and 3** (its outcomes change those commits), after any further plan lands — if 003 executes first, rebuild `dist/` again so the linked CSS is current.
- **Purely additive**: lives outside `webapp/src/`, links compiled CSS from `dist/`, so it cannot conflict with any executing plan thread and is not part of any bundle. Do not wire it into the router.
- The app CSS uses Tailwind `@apply`, so the sandbox must link **compiled** CSS, not source stylesheets.

## Repo conventions to follow

- Token values resolve at runtime — the compiled CSS keeps `var(--dur-panel)`, `var(--ease-out-strong)` etc., so variant overrides can use tokens directly.
- Sheet transition exemplar being varied: `.mobile-detail-sheet` (`responsive.css:517-537` at 7889cfd; re-locate by quoted values after plans land).
- Row press exemplar to imitate if P1 wins: `.btn:active { transition-duration: var(--dur-instant); }` (forms.css:166-169).

## Steps

Setup:
1. From the repo root (plans 001/002/005 are landed; if 003/004 landed more recently, rebuild anyway): `npm run build`.
2. `mkdir -p prototype/motion-sandbox && cp dist/assets/*.css prototype/motion-sandbox/app.css`.
3. Create `prototype/motion-sandbox/index.html` linking `app.css` plus a small local `<style>` block containing the variant rules below, and open it directly in a browser (`file://` works — no dev server, no build config changes).

Sheet-curve variants (V0–V2), applied as a class on the sheet replica, all using `transform-origin: top center` (plan 006's origin fix):

```css
/* shared: .sheet { … } uses the real .mobile-detail-sheet class list; variant classes override the transition */
.sheet.variant-v0 { transition: opacity var(--dur-fast) var(--ease-out-soft), transform var(--dur-panel) var(--ease-out-strong), visibility var(--dur-fast); }
.sheet.variant-v1 { transition: opacity var(--dur-fast) var(--ease-out-soft), transform var(--dur-panel) cubic-bezier(0.34, 1.28, 0.64, 1), visibility var(--dur-fast); }  /* subtle spring, overshoot ≈ bounce 0.1–0.2 */
.sheet.variant-v2 { transition: opacity var(--dur-fast) var(--ease-out-soft), transform var(--dur-panel) cubic-bezier(0.34, 1.56, 0.64, 1), visibility var(--dur-fast); }  /* current 1.56 overshoot */
```

Row-press variants (P0–P2) on a replica list of ≥6 `.list-item` rows — the landed press is the incumbent:

```css
/* P0: no press (today's pre-001 behavior) */
.rows.variant-p0 .list-item:active { transform: none; transition-duration: 0s; }
/* P1: the landed press (incumbent) — no rule needed; the compiled CSS already has .list-item:active { transform: scale(0.98); transition-duration: var(--dur-instant); } */
/* P2: lighter press — if P1 reads heavy at 100% speed */
.rows.variant-p2 .list-item:active { transform: scale(0.99); transition-duration: var(--dur-instant); }
```

Page chrome (vanilla JS only, ~30 lines):
4. A radio group (V0/V1/V2) toggling `variant-*` on the sheet; an Open/Close button toggling the `.open` class (`translate3d(0,20px,0)` ↔ `translate3d(0,0,0)`); a radio group (P0/P1/P2) on the rows; a light/dark toggle setting `data-theme="dark"` on `<html>` (the app's dark selector is `[data-theme="dark"]`, per `tailwind.config.js:4`).
5. Sheet content: placeholder `.card` blocks (3 stacked sections with realistic padding/height, using the real `.card` class) — enough weight to judge the settle; content fidelity is not the question.

Decision pass:
6. Flip through V0→V1→V2: open/close each at 100% speed, again with DevTools → Animations panel at 10%. Judge in both themes, and confirm reduced-motion (Rendering panel) collapses all three to instant-appear.
7. Flip P0/P1/P2: tap rows rapidly. P1 (the landed press) is the incumbent — confirm it never interferes with selection or hover and reads as feedback rather than lag; if it reads heavy at 100% speed, check whether P2 fixes it.

## Decision recording

1. Record both outcomes in `plans/README.md`'s taste-call section: `decided: V0/V1/V2`, `decided: keep P1 / retune to P2 / drop press`.
2. Fold outcomes in (do **not** edit 001 retroactively — it is DONE):
   - Sheet curve → plan 006 commit 2 uses the winner for `.mobile-detail-sheet`. If the winner is V1/V2, scope the spring to the sheet **only** — tab and FAB stay crisp per plan 006's original target (the sandbox tests the sheet, which is the contested surface).
   - Row press → three outcomes: **keep P1** (default — no action, it's landed), **retune to P2** (one-line edit: fold the `scale(0.99)` value into plan 006 commit 3's press rules and amend the landed commit's value there), or **drop press** (note it in the README so the upstream owner knows this commit is the one to drop).
3. Lifecycle: keep `prototype/motion-sandbox/` untracked (or commit it on the branch as the decision's primary source); delete after recording if you prefer. It must never enter a PR.

## Boundaries

- Do NOT modify anything under `webapp/src/` in this plan — applying the decision happens via plans 001/006 as stated above.
- Do NOT test route entrances or the unlock handoff here — those need the real app's routes and decrypt timing (plan 007's feel-checks cover them).
- Do NOT add dependencies or framework JS; radios + one toggle button.
- If the compiled CSS copy drifts from the sheet's source rules (e.g. plan 006 already landed and changed the curve), re-copy from a fresh `dist/` before judging.

## Verification

- **Mechanical**: the picker toggles all six variants; the page renders with the app's real fonts/tokens/panels (proof it linked the right CSS).
- **Feel check**: as in step 6-7 — the distinguishing observation is at 10% slow motion: V1's overshoot should read as a subtle confident settle, V2's as a playful bounce. If V1 and V2 are indistinguishable at 100% speed, pick the cheaper one (V1) and note it.
- **Done when**: `plans/README.md` taste-call rows carry recorded decisions, and the outcomes are folded into plans 001/006 (or consciously dropped).

## Outcome (recorded 2026-09-26)

- **Sheet curve (feeds plan 006 commit 2): V2 — today's spring wins.** `.mobile-detail-sheet` keeps `transform … var(--ease-spring)`; the sidebar sheet, tab, and FAB still unify to crisp; `--ease-out-expo` is removed, `--ease-spring` is kept (single live use). Plan 006 has been updated with the revised target, step, and verification guard.
- **Row press (001 commit 4): P1 — the landed press is confirmed.** No code change; upstream may still drop `96c31dc` independently if they disagree.
- **Sandbox lifecycle**: kept on disk at `prototype/motion-sandbox/` (untracked) as the decision's primary source; not wired into the router or build. Delete whenever.
