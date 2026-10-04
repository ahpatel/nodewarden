// Tests for the bulk move-to-collection feature (drag items onto an
// organization collection in the vault sidebar).
//
// 1. Functional: the grouping planner is the correctness core — the bulk
//    endpoint REPLACES each cipher's collection links, so "add to target"
//    must send [previous..., target] and group ciphers by identical
//    previous sets. A mistake here silently rewrites memberships.
// 2. Patterns: the client wiring, the server endpoint's authorization
//    invariants, and the i18n keys living in the org bundle.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const { planBulkCollectionMove } = await import('../webapp/src/lib/bulk-collection-groups');
const root = resolve(import.meta.dirname, '..');

function read(path: string): string {
  return readFileSync(resolve(root, path), 'utf-8');
}

test('planner: ciphers with identical previous sets share one bulk call', () => {
  const plan = planBulkCollectionMove(
    [
      { id: 'a', previousCollectionIds: ['c1', 'c2'] },
      { id: 'b', previousCollectionIds: ['c2', 'c1'] },
      { id: 'c', previousCollectionIds: ['c1', 'c2'] },
    ],
    'target'
  );
  assert.equal(plan.moveGroups.length, 1, 'one group for one distinct previous set');
  assert.deepEqual([...plan.moveGroups[0].cipherIds].sort(), ['a', 'b', 'c']);
  assert.deepEqual(
    [...plan.moveGroups[0].collectionIds].sort(),
    ['c1', 'c2', 'target'],
    'the call sends previous set + target (add semantics)'
  );
});

test('planner: ciphers with different previous sets go in separate calls', () => {
  const plan = planBulkCollectionMove(
    [
      { id: 'a', previousCollectionIds: ['c1'] },
      { id: 'b', previousCollectionIds: ['c1', 'c2'] },
      { id: 'c', previousCollectionIds: [] },
    ],
    'target'
  );
  assert.equal(plan.moveGroups.length, 3, 'three distinct previous sets');
  const byId = new Map(plan.moveGroups.flatMap((group) => group.cipherIds.map((id) => [id, group.collectionIds] as const)));
  assert.deepEqual(byId.get('a'), ['c1', 'target']);
  assert.deepEqual(byId.get('b'), ['c1', 'c2', 'target']);
  assert.deepEqual(byId.get('c'), ['target'], 'a cipher with no collections gets only the target');
});

test('planner: ciphers already in the target are no-ops', () => {
  const plan = planBulkCollectionMove(
    [
      { id: 'already', previousCollectionIds: ['c1', 'target'] },
      { id: 'mover', previousCollectionIds: ['c1'] },
    ],
    'target'
  );
  assert.deepEqual(plan.alreadyInTargetIds, ['already']);
  assert.deepEqual(plan.moveGroups.flatMap((g) => g.cipherIds), ['mover'], 'only the mover is sent');
});

test('planner: undo groups exclude ciphers that had no collections', () => {
  const plan = planBulkCollectionMove(
    [
      { id: 'restorable', previousCollectionIds: ['c1'] },
      { id: 'unrestorable', previousCollectionIds: [] },
      { id: 'shared', previousCollectionIds: ['c1'] },
    ],
    'target'
  );
  assert.equal(plan.undoGroups.length, 1, 'one restore group for one previous set');
  assert.deepEqual([...plan.undoGroups[0].cipherIds].sort(), ['restorable', 'shared']);
  assert.deepEqual(plan.undoGroups[0].collectionIds, ['c1'], 'restore sends exactly the pre-move set');
  const unrestorableGroup = plan.moveGroups.find((group) => group.cipherIds.includes('unrestorable'));
  assert.ok(unrestorableGroup, 'the unrestorable cipher is still moved');
});

test('planner: empty input and empty target produce empty groups', () => {
  const plan = planBulkCollectionMove([], 'target');
  assert.deepEqual(plan.alreadyInTargetIds, []);
  assert.deepEqual(plan.moveGroups, []);
  assert.deepEqual(plan.undoGroups, []);
});

// ─── Client wiring patterns ─────────────────────────────────────────────────

test('client wiring uses the planner and the bulk endpoint', () => {
  const hook = read('webapp/src/hooks/useVaultSendActions.ts');
  assert.ok(hook.includes('planBulkCollectionMove'), 'the hook plans moves through the shared helper');
  assert.ok(hook.includes('bulkSetCipherCollections(authedFetch, group.cipherIds, group.collectionIds)'), 'each group is one bulk call');
  assert.ok(
    hook.includes('plan.undoGroups.reduce((sum, group) => sum + group.cipherIds.length, 0)'),
    'the undo toast reports the actually-restorable count'
  );
  const api = read('webapp/src/lib/api/vault.ts');
  assert.ok(
    api.includes("'/api/ciphers/bulk/collections'"),
    'the api client targets the bulk flexible-collections endpoint'
  );
});

test('sidebar excludes read-only collections from drop targets', () => {
  const sidebar = read('webapp/src/components/vault/VaultSidebar.tsx');
  assert.ok(sidebar.includes('onDropToCollection'), 'collection rows take a collection drop handler');
  assert.ok(
    /readOnly\s*\n?\s*\?\s*\{\}/.test(sidebar),
    'read-only collections render without drop handlers'
  );
});

test('demo mode mirrors the real add semantics', () => {
  const demo = read('webapp/src/lib/demo.ts');
  assert.ok(demo.includes('onBulkMoveToCollectionVaultItems'), 'demo wires the action');
  assert.ok(
    !demo.includes("name: ''"),
    'demo no longer renders a toast with an empty collection name'
  );
});

// ─── Server bulk endpoint invariants ────────────────────────────────────────

test('server bulk collections endpoint enforces its invariants', () => {
  const ciphers = read('src/handlers/ciphers.ts');
  const handler = ciphers.slice(ciphers.indexOf('export async function handleBulkSetCipherCollections'));
  assert.ok(
    handler.includes('Ciphers from multiple organizations cannot be moved together'),
    'mixed-organization payloads are rejected'
  );
  assert.ok(
    handler.includes('verifyTargetCollectionsEditable'),
    'target collections are editability-checked'
  );
  assert.ok(
    handler.includes("writeCipherAudit(storage, request, userId, 'cipher.collections.update.bulk'"),
    'bulk moves are audited'
  );
  assert.ok(
    handler.includes('await bumpOrganizationMembers(request, env, storage, organizationId)'),
    'members are notified so official clients resync'
  );
});

test('server bulk collections endpoint enforces the 500-item id cap like its siblings', () => {
  const ciphers = read('src/handlers/ciphers.ts');
  const handler = ciphers.slice(ciphers.indexOf('export async function handleBulkSetCipherCollections'));
  assert.ok(
    handler.includes('LIMITS.performance.maxBulkRequestIds'),
    'the bulk collections cap uses the shared limit'
  );
  const capChecks = handler.match(/maxBulkRequestIds/g) || [];
  assert.ok(
    capChecks.length >= 2,
    'the cap covers both cipherIds and collectionIds'
  );
  assert.ok(
    handler.includes("ids array is limited to ${LIMITS.performance.maxBulkRequestIds} items"),
    'the cap uses the same error shape as the sibling bulk endpoints'
  );
});

// ─── i18n bundle placement ──────────────────────────────────────────────────

test('feature keys live in the org bundle, not the base bundle', () => {
  for (const locale of ['de', 'en', 'es', 'fi', 'fr', 'it', 'ru', 'sv', 'zh-CN', 'zh-TW']) {
    const orgBundle = read(`webapp/src/lib/i18n/org/${locale}.ts`);
    assert.ok(orgBundle.includes('txt_move_to_collection_skipped'), `${locale} org bundle has the skip key`);
    assert.ok(orgBundle.includes('txt_bulk_move_to_collection_failed'), `${locale} org bundle has the failure key`);
    const baseBundle = read(`webapp/src/lib/i18n/locales/${locale}.ts`);
    assert.ok(
      !baseBundle.includes('txt_move_to_collection_skipped'),
      `${locale} base bundle does not duplicate the key`
    );
  }
});
