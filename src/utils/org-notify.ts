import type { Env } from '../types';
import { StorageService } from '../services/storage';
import { notifyUserVaultSync } from '../durable/notifications-hub';
import { readActingDeviceIdentifier } from './device';

// Fan out a revision bump + sync push to every confirmed member of an
// organization. Organization data lives in every member's sync payload, so any
// org change (cipher, collection, membership, permissions) invalidates every
// member's cached sync response.
export async function bumpOrganizationMembers(
  request: Request,
  env: Env,
  storage: StorageService,
  organizationId: string,
  exceptUserId?: string
): Promise<void> {
  const members = await storage.listConfirmedOrganizationUserIds(organizationId);
  const memberUserIds = members
    .map((member) => member.userId)
    .filter((id) => !(exceptUserId && id === exceptUserId));
  if (!memberUserIds.length) return;

  // One batched revision write for the whole org instead of one sequential
  // D1 write per member, then concurrent notification fan-out. This loop runs
  // on every shared-item mutation, so the sequential form added latency
  // proportional to membership on every edit.
  const revisionDate = await storage.updateRevisionDates(memberUserIds);
  const contextId = readActingDeviceIdentifier(request);
  await Promise.all(
    memberUserIds.map((memberUserId) => notifyUserVaultSync(env, memberUserId, revisionDate, contextId))
  );
}
