# 001 — Subtract decorative motion from high-frequency surfaces

- **Status**: DONE (commits 2f7ab1c..96c31dc on `modern-ui`; 4 commits as planned, commit 4 included)
- **Commit**: 7889cfd
- **Severity**: HIGH
- **Category**: Purpose & frequency (audit findings 1, 5, 12, 13-optional)
- **Estimated scope**: 7 files, ~120 lines removed, ~6 lines added
- **PR**: A — `chore(webapp): remove decorative motion from high-frequency surfaces`

## Problem

The product's most-used interactions carry decorative motion whose only purpose is "looks cool", plus a dead motion layer that two stylesheets maintain in opposition. All current code verified at commit 7889cfd.

**Finding 1 — detail pane replays a choreography on every item selection (100+/day):**
Every vault item click remounts the detail pane via a `key`, replaying a stage fade + per-card cascade (~440ms).

```css
/* webapp/src/styles/vault.css:806-812 — current */
.detail-switch-stage {
  animation: fade-in 160ms var(--ease-out-soft) both;
}

.detail-switch-stage > .card {
  animation: surface-enter 280ms var(--ease-out-soft) both;
}
/* plus .detail-col > .card at :796-798 and nth-of-type animation-delays at :800-804 */
```

```tsx
/* webapp/src/components/VaultPage.tsx:1348 and :1389 — current */
<div key={`editor-${draft.id || selectedCipher?.id || 'new'}-${draft.type}`} className="detail-switch-stage">
<div key={`detail-${selectedCipher.id}`} className="detail-switch-stage">
```

**Finding 5 — decorative hover lifts/micro-motion on high-frequency controls** (color/shadow hover states already communicate the same thing):

```css
/* styles.css:582-584 */   .btn:hover:not(:disabled) { transform: translateY(-1px); }
/* forms.css:161-164 */    .btn:hover:not(:disabled) { transform: translateY(-1px); transition-duration: var(--dur-quick); }
/* forms.css:166-169 */    .btn:active:not(:disabled) { transform: translateY(0) scale(0.97); transition-duration: var(--dur-instant); }
/* forms.css:206 */       .btn-primary:hover { … transform: translateY(-2px); }
/* forms.css:194-211 */    .btn-primary::before { …opacity: 0; … }  /* gradient sheen, fades in on hover */
/* forms.css:~66 */        .input:focus { … transform: translateY(-1px); }
/* shell.css:237 */        .side-link:hover, .side-group-trigger:hover { … transform: translateX(2px); }
/* vault.css:395-398 */    .sort-menu-item:hover { background: #f2f7ff; transform: translateX(2px); }
/* management.css:1596-1599 */ .create-menu-item:hover { … transform: translateX(2px); }
/* vault.css:757-766 */    .list-item:hover .list-icon-wrap { transform: translateX(1px) scale(1.04); } /* + .list-icon-fallback scale(1.04) */
/* vault.css:83-87 */      .search-clear-btn:hover { … transform: translateY(-50%) scale(1.04); }
/* forms.css:98-122 */     .input-icon-btn / .eye-btn / .password-toggle hover: scale(1.04)
/* vault.css:142-167 */    .folder-delete-btn / .folder-sort-btn hover: scale(1.06)
/* management.css:2059-2063 */ .domain-rule-expand-btn:hover { transform: translateY(-1px); }
/* responsive.css:320-322 */ .mobile-sidebar-close:hover { transform: scale(1.05); }
/* responsive.css:253-255 */ .mobile-tab:hover { transform: translateY(-2px); }
```

**Finding 12 — dead motion layer.** vault.css declares hover choreography that styles.css then neutralizes; both still ship. Also the topbar `::before` glow is `opacity: 0` in both base and hover state.

```css
/* vault.css:454-465 — current */ .list-item::before { … transform: translateX(-8px); transition: opacity var(--dur-fast) …, transform 320ms var(--ease-out-soft); }
/* styles.css:646-648 — the override that kills it */ .list-item::before { display: none; }
/* styles.css:656-668 */ .list-item:hover .row-main, … .list-text, … .list-sub { transform: none; } .list-item:hover .list-title { letter-spacing: 0; }
/* forms.css:140-159 — never-visible glow */ .topbar-actions .btn::before, .user-chip::before, .side-link::before, .mobile-tab::before { … opacity: 0; … } and :hover::before { opacity: 0; }
```

**Finding 13 (OPTIONAL COMMIT, taste call) — vault rows have no press feedback.** `.btn` copy buttons (also 100+/day) already have `:active` scale; rows are the one pressable class without it.

## Target

Item selection and copy actions feel instant; hover communicates via color/shadow only; one source of truth per rule. Exact end state:

```css
/* forms.css — target */
.btn:hover:not(:disabled) { transition-duration: var(--dur-quick); }          /* transform line deleted */
.btn:active:not(:disabled) { transform: scale(0.97); transition-duration: var(--dur-instant); }
/* .btn-primary::before block (194-201) and .btn-primary:hover::before (209-211) deleted entirely */
/* .btn-primary:hover (203-207): only the `transform: translateY(-2px);` line deleted */
/* .input:focus: only the `transform: translateY(-1px);` line deleted */

/* vault.css — target (optional commit) */
.list-item:active { transform: scale(0.98); transition-duration: var(--dur-instant); }
```

`detail-switch-stage` entrance rules and all `animation-delay` tiers for detail cards: **deleted** (not replaced). The `key` props in VaultPage.tsx:1348/:1389 **stay** — they are state isolation for the editor, not motion; with the CSS deleted the remount is visually instant, which is correct for a 100+/day action.

## Repo conventions to follow

- Durations/curves are tokens (`tokens.css:41-46`: `--dur-instant` 80ms, `--dur-quick` 120ms, `--dur-fast` 180ms, `--dur-medium` 240ms; `--ease-out-soft`, `--ease-smooth`). Any new value must use a token.
- Press-feedback exemplar: `forms.css:161-169` — hover settles at `--dur-quick`, `:active` snaps at `--dur-instant`.

## Steps

Commit 1 — detail pane (finding 1):
1. `webapp/src/styles/vault.css`: delete rules at lines 796-812 (`.detail-col > .card`, the five `.detail-col > .card:nth-of-type` delay rules, `.detail-switch-stage`, `.detail-switch-stage > .card`).
2. Verify no other surface relied on them: `rg 'detail-col > |detail-switch-stage' webapp/src` — SendsPage detail cards also use these classes; their entrance goes instant too. **This is intended** (occasional-tier surfaces don't need card cascades).
3. Leave both `key` props in VaultPage.tsx untouched.

Commit 2 — hover subtraction (finding 5):
4. `webapp/src/styles.css`: delete the `.btn:hover:not(:disabled) { transform: … }` rule (582-584); change `.btn:active:not(:disabled)` to `transform: scale(0.98);` (drop `translateY(0)`).
5. `webapp/src/styles/forms.css`: in `.btn:hover:not(:disabled)` delete the `transform` line, keep `transition-duration: var(--dur-quick);`; in `.btn:active:not(:disabled)` change transform to `scale(0.97)`; delete the `.btn-primary::before` rule and `.btn-primary:hover::before`; in `.btn-primary:hover` delete the `transform` line; in `.input:focus` delete the `transform` line.
6. `webapp/src/styles/shell.css`: in `.side-link:hover, .side-group-trigger:hover` delete the `transform` line (keep background/border changes).
7. `webapp/src/styles/vault.css`: delete `transform` from `.sort-menu-item:hover` (395-398); in the `.list-item:hover/.active .list-icon-wrap` and `.list-icon-fallback` rules (757-766) delete the `transform` declarations, **keep the `color` change**; in `.search-clear-btn:hover` delete only `scale(1.04)` — **keep `translateY(-50%)` (that is element positioning, not motion)**; delete hover `scale(1.06)` from `.folder-delete-btn`/`.folder-sort-btn` (142-167).
8. `webapp/src/styles/forms.css`: delete hover `scale(1.04)` from `.input-icon-btn`, `.eye-btn`, `.password-toggle` (98-122).
9. `webapp/src/styles/management.css`: delete `transform` from `.create-menu-item:hover` (1596-1599) and `.domain-rule-expand-btn:hover` (2059-2063).
10. `webapp/src/styles/responsive.css`: delete `.mobile-sidebar-close:hover { transform: scale(1.05); }` (320-322) and `.mobile-tab:hover { transform: translateY(-2px); }` (253-255).
11. `webapp/src/styles.css`: now that `.mobile-tab:hover` motion is gone at source, delete the dead neutralization at 1035-1037.

Commit 3 — dead layer (finding 12):
12. `webapp/src/styles/vault.css`: delete `.list-item::before` (454-465), the row-child transform/letter-spacing hover rules (768-782), the `letter-spacing` transition on `.list-title` (733), and the dead transform transitions on `.row-main`/`.list-text`/`.list-sub` (567-573, 754) — after step 7, `rg ':hover' webapp/src/styles/vault.css` must show no `transform` on list rows or their children.
13. `webapp/src/styles.css`: delete the now-redundant neutralization rules 646-668 (`.list-item::before { display: none }`, the `transform: none` block, the `letter-spacing: 0` block).
14. `webapp/src/styles/forms.css`: delete the never-visible glow: rules 140-159 (`.topbar-actions .btn::before, …` and the `:hover::before` rule). Keep the `@apply relative overflow-hidden` at 133-138 (used for other purposes).

Commit 4 (OPTIONAL — drop-able, taste call) — row press (finding 13):
<!-- Status update: this commit LANDED (96c31dc). Plan 000 (motion decision sandbox) now includes a P0/P1/P2 feel-confirm of the landed press, with the option to retune to scale(0.99) via plan 006 commit 3 or to flag this commit as the one upstream may drop. -->
15. `webapp/src/styles/vault.css`: add `.list-item:active { transform: scale(0.98); transition-duration: var(--dur-instant); }` next to the `.list-item` rule. Do not touch the deliberate no-motion zones at `vault.css:259-271` and `management.css:945-951`.

## Boundaries

- Do NOT touch the deliberate `transform: none !important` zones (`vault.css:259-271`, `management.css:945-951`) — settled design.
- Do NOT change markup/JSX in this plan (keys stay).
- Do NOT touch dialogs/menus/toasts (plan 004), tokens (005), or reduced-motion (002).
- If any cited line no longer matches (drift since 7889cfd), STOP and report instead of improvising.

## Verification

- **Mechanical**: `npm run build` succeeds; `rg ':hover' webapp/src/styles | rg transform` returns no hits inside the vault/shell/forms/management/responsive files listed above.
- **Feel check**: run `npm run dev`, open the vault with several items:
  - Click item-to-item rapidly: the detail pane swaps instantly with **no fade, no card cascade** — confirm no visual flash or stagger.
  - Hover a row / button: only color + border + shadow change; nothing moves.
  - DevTools → Animations panel at 10%: selecting items produces **zero** animation entries.
  - Press a `.btn` (copy button): still snaps down (`scale(0.97-0.98)`) — press feedback must survive this plan.
  - With commit 4 applied: press a vault row — it dims slightly smaller and returns; hover produces no movement.
- **Done when**: no hover rule in the listed files animates `transform`; the vault detail swap is animation-free; build passes.
