// CONTRACT:
// Pure grouping logic for bulk collection moves. The bulk endpoint REPLACES
// each cipher's collection links with the ids in the payload, so an
// "add to target" move must send [previous..., target] — and ciphers with
// different previous sets must go in separate calls, because one shared call
// would overwrite one cipher's links with another cipher's list. Grouping by
// the sorted previous-set key minimizes the number of server round-trips.
//
// Undo is the same algorithm in reverse: a restore call sends exactly the
// pre-move set. Ciphers that had NO collections before the move are not
// restorable (the server rejects empty link lists), so they are excluded
// from the undo groups and keep the added collection.

export interface BulkCollectionGroup {
  /** Cipher ids sharing the same previous collection set. */
  cipherIds: string[];
  /** The exact collection-id list to send for this call. */
  collectionIds: string[];
}

export interface BulkCollectionMovePlan {
  /** Ciphers that already carry the target collection: no-ops. */
  alreadyInTargetIds: string[];
  /** Calls to perform the move (add semantics: previous set + target). */
  moveGroups: BulkCollectionGroup[];
  /** Calls to restore the pre-move state on undo (non-empty sets only). */
  undoGroups: BulkCollectionGroup[];
}

function previousSetKey(previousCollectionIds: string[]): string {
  return [...previousCollectionIds].sort().join('\n');
}

export function planBulkCollectionMove(
  entries: Array<{ id: string; previousCollectionIds: string[] }>,
  targetCollectionId: string
): BulkCollectionMovePlan {
  const target = String(targetCollectionId || '').trim();

  const seen = new Set<string>();
  const orderedEntries: Array<{ id: string; previousCollectionIds: string[] }> = [];
  for (const entry of entries) {
    const id = String(entry?.id || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    orderedEntries.push({ id, previousCollectionIds: Array.isArray(entry.previousCollectionIds) ? entry.previousCollectionIds : [] });
  }

  const alreadyInTargetIds: string[] = [];
  const movers = orderedEntries.filter((entry) => {
    if (entry.previousCollectionIds.includes(target)) {
      alreadyInTargetIds.push(entry.id);
      return false;
    }
    return true;
  });

  const moveGroupsByPrevious = new Map<string, BulkCollectionGroup>();
  for (const entry of movers) {
    const key = previousSetKey(entry.previousCollectionIds);
    let group = moveGroupsByPrevious.get(key);
    if (!group) {
      group = { cipherIds: [], collectionIds: [...entry.previousCollectionIds, target] };
      moveGroupsByPrevious.set(key, group);
    }
    group.cipherIds.push(entry.id);
  }

  const undoGroupsByPrevious = new Map<string, BulkCollectionGroup>();
  for (const entry of movers) {
    if (!entry.previousCollectionIds.length) continue; // not restorable
    const key = previousSetKey(entry.previousCollectionIds);
    let group = undoGroupsByPrevious.get(key);
    if (!group) {
      group = { cipherIds: [], collectionIds: [...entry.previousCollectionIds] };
      undoGroupsByPrevious.set(key, group);
    }
    group.cipherIds.push(entry.id);
  }

  return {
    alreadyInTargetIds,
    moveGroups: Array.from(moveGroupsByPrevious.values()),
    undoGroups: Array.from(undoGroupsByPrevious.values()),
  };
}
