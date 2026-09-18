import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import { Plus, RefreshCw, SlidersHorizontal, Trash2 } from 'lucide-preact';
import ConfirmDialog from '@/components/ConfirmDialog';
import { base64ToBytes, decryptStr } from '@/lib/crypto';
import {
  type OrganizationCollection,
  type OrganizationMember,
  type OrganizationSummary,
  acceptOrganizationInvitation,
  confirmOrganizationMember,
  createOrganization,
  createOrganizationCollection,
  deleteOrganization,
  deleteOrganizationCollection,
  getOrganizationMember,
  inviteOrganizationMembers,
  leaveOrganization,
  listMyOrganizations,
  listOrganizationCollections,
  listOrganizationMembers,
  removeOrganizationMember,
  updateOrganization,
  updateOrganizationMember,
} from '@/lib/api/organizations';
import {
  type OrgKeyParts,
  encryptWithOrgKey,
  generateOrganizationKeyBytes,
  generateOrganizationKeyPair,
  orgKeyBytesToParts,
  wrapOrganizationKeyForUser,
} from '@/lib/org-crypto';
import type { OrgKeyMap } from '@/lib/vault-decrypt';
import type { AuthedFetch } from '@/lib/api/shared';
import type { Profile, SessionState } from '@/lib/types';
import { t } from '@/lib/i18n';

interface OrganizationsPageProps {
  profile: Profile | null;
  session: SessionState | null;
  authedFetch: AuthedFetch;
  orgKeys: OrgKeyMap | null;
  onNotify: (type: 'success' | 'error' | 'warning', text: string) => void;
  onRefresh: () => Promise<void>;
  onNavigate: (path: string) => void;
}

const STATUS_INVITED = 1;
const STATUS_ACCEPTED = 2;
const STATUS_CONFIRMED = 3;
const TYPE_OWNER = 0;

function orgKeyMaterialFromMap(orgKeys: OrgKeyMap | null, organizationId: string): OrgKeyParts | null {
  const material = orgKeys?.[organizationId];
  if (!material) return null;
  return {
    encB64: material.encB64,
    macB64: material.macB64,
    encBytes: base64ToBytes(material.encB64),
    macBytes: base64ToBytes(material.macB64),
  };
}

async function decryptOrgName(value: string, orgKeys: OrgKeyMap | null, organizationId: string): Promise<string> {
  const material = orgKeyMaterialFromMap(orgKeys, organizationId);
  if (!material) return '';
  try {
    return await decryptStr(value, material.encBytes, material.macBytes);
  } catch {
    return '';
  }
}

export default function OrganizationsPage(props: OrganizationsPageProps) {
  const [organizations, setOrganizations] = useState<OrganizationSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [displayNames, setDisplayNames] = useState<Record<string, string>>({});
  const [selectedOrgId, setSelectedOrgId] = useState<string | null>(null);
  const [members, setMembers] = useState<OrganizationMember[]>([]);
  const [collections, setCollections] = useState<OrganizationCollection[]>([]);
  const [collectionNames, setCollectionNames] = useState<Record<string, string>>({});
  const [detailLoading, setDetailLoading] = useState(false);
  const [createName, setCreateName] = useState('');
  const [creating, setCreating] = useState(false);
  const [newCollectionName, setNewCollectionName] = useState('');
  const [inviteEmails, setInviteEmails] = useState('');
  const [inviteAccessAll, setInviteAccessAll] = useState(true);
  const [inviteSubmitting, setInviteSubmitting] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [permissionsMember, setPermissionsMember] = useState<OrganizationMember | null>(null);
  const [permissionsRows, setPermissionsRows] = useState<Array<{ id: string; name: string; enabled: boolean; readOnly: boolean; hidePasswords: boolean }>>([]);
  const [permissionsSubmitting, setPermissionsSubmitting] = useState(false);

  const selectedOrganization = useMemo(
    () => organizations.find((org) => org.id === selectedOrgId) || null,
    [organizations, selectedOrgId]
  );
  const selectedIsOwner = !!selectedOrganization && Number(selectedOrganization.type) === TYPE_OWNER;

  const notify = props.onNotify;
  const authedFetch = props.authedFetch;
  const orgKeys = props.orgKeys;
  const onRefreshVault = props.onRefresh;

  const refreshOrganizations = useCallback(async () => {
    try {
      setError('');
      const list = await listMyOrganizations(authedFetch);
      setOrganizations(list);
      const names: Record<string, string> = {};
      for (const org of list) {
        if (Number(org.status) === STATUS_CONFIRMED && orgKeys) {
          names[org.id] = await decryptOrgName(org.name, orgKeys, org.id);
        }
      }
      setDisplayNames(names);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('txt_organizations_load_failed'));
    } finally {
      setLoading(false);
    }
  }, [authedFetch, orgKeys]);

  useEffect(() => {
    void refreshOrganizations();
  }, [refreshOrganizations]);

  const refreshOrgDetail = useCallback(async (organizationId: string) => {
    if (!orgKeys) return;
    setDetailLoading(true);
    try {
      const [memberList, collectionList] = await Promise.all([
        listOrganizationMembers(authedFetch, organizationId),
        listOrganizationCollections(authedFetch, organizationId),
      ]);
      setMembers(memberList);
      setCollections(collectionList);
      const names: Record<string, string> = {};
      for (const collection of collectionList) {
        try {
          names[collection.id] = await decryptStr(collection.name, base64ToBytes(orgKeys[organizationId]?.encB64 || ''), base64ToBytes(orgKeys[organizationId]?.macB64 || ''));
        } catch {
          names[collection.id] = '';
        }
      }
      setCollectionNames(names);
    } catch (err) {
      notify('error', err instanceof Error ? err.message : t('txt_organizations_load_failed'));
    } finally {
      setDetailLoading(false);
    }
  }, [authedFetch, orgKeys, notify]);

  useEffect(() => {
    if (selectedOrgId && Number(selectedOrganization?.status) === STATUS_CONFIRMED && orgKeys?.[selectedOrgId]) {
      void refreshOrgDetail(selectedOrgId);
    } else {
      setMembers([]);
      setCollections([]);
      setCollectionNames({});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedOrgId, selectedOrganization?.status, selectedOrgId ? orgKeys?.[selectedOrgId] : undefined]);

  async function handleCreateOrganization() {
    const name = createName.trim();
    if (!name) {
      notify('warning', t('txt_organizations_name_required'));
      return;
    }
    setCreating(true);
    try {
      const rawKey = generateOrganizationKeyBytes();
      const parts = orgKeyBytesToParts(rawKey);
      const keyPair = await generateOrganizationKeyPair(parts);
      if (!props.profile?.publicKey) {
        throw new Error(t('txt_organizations_missing_public_key'));
      }
      const wrappedKey = await wrapOrganizationKeyForUser(rawKey, props.profile.publicKey);
      const encName = await encryptWithOrgKey(name, parts);
      const encCollectionName = await encryptWithOrgKey(name, parts);
      await createOrganization(authedFetch, {
        name: encName,
        key: wrappedKey,
        keys: { publicKey: keyPair.publicKeyB64, encryptedPrivateKey: keyPair.encryptedPrivateKey },
        collectionName: encCollectionName,
        billingEmail: props.profile?.email || null,
      });
      setCreateName('');
      notify('success', t('txt_organizations_created'));
      await refreshOrganizations();
      await onRefreshVault();
    } catch (err) {
      notify('error', err instanceof Error ? err.message : t('txt_organizations_create_failed'));
    } finally {
      setCreating(false);
    }
  }

  async function handleAcceptInvitation(org: OrganizationSummary) {
    setBusy(org.id);
    try {
      await acceptOrganizationInvitation(authedFetch, org.id, org.organizationUserId);
      notify('success', t('txt_organizations_invite_accepted'));
      await refreshOrganizations();
      await onRefreshVault();
    } catch (err) {
      notify('error', err instanceof Error ? err.message : t('txt_organizations_invite_accept_failed'));
    } finally {
      setBusy(null);
    }
  }

  async function handleConfirmMember(member: OrganizationMember) {
    if (!selectedOrgId || !orgKeys?.[selectedOrgId] || !member.userId) return;
    setBusy(member.id);
    try {
      const details = await getOrganizationMember(authedFetch, selectedOrgId, member.id);
      if (!details.publicKey) {
        throw new Error(t('txt_organizations_member_no_key'));
      }
      const material = orgKeys[selectedOrgId];
      const raw = new Uint8Array(64);
      raw.set(base64ToBytes(material.encB64), 0);
      raw.set(base64ToBytes(material.macB64), 32);
      const wrapped = await wrapOrganizationKeyForUser(raw, details.publicKey);
      await confirmOrganizationMember(authedFetch, selectedOrgId, member.id, wrapped);
      notify('success', t('txt_organizations_member_confirmed'));
      await refreshOrgDetail(selectedOrgId);
      await onRefreshVault();
    } catch (err) {
      notify('error', err instanceof Error ? err.message : t('txt_organizations_confirm_failed'));
    } finally {
      setBusy(null);
    }
  }

  async function handleInvite() {
    if (!selectedOrgId) return;
    const emails = inviteEmails
      .split(/[\s,;]+/)
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean);
    if (!emails.length) {
      notify('warning', t('txt_organizations_invite_emails_required'));
      return;
    }
    setInviteSubmitting(true);
    try {
      const result = await inviteOrganizationMembers(authedFetch, selectedOrgId, {
        emails,
        accessAll: inviteAccessAll,
      });
      const registered = result.invited.filter((item) => item.registered).length;
      const withCode = result.invited.length - registered;
      let message = t('txt_organizations_invite_sent', { count: String(result.invited.length) });
      if (withCode > 0) {
        message += ' ' + t('txt_organizations_invite_codes_note', { count: String(withCode) });
      }
      notify('success', message);
      setInviteEmails('');
      await refreshOrgDetail(selectedOrgId);
    } catch (err) {
      notify('error', err instanceof Error ? err.message : t('txt_organizations_invite_failed'));
    } finally {
      setInviteSubmitting(false);
    }
  }

  async function handleRemoveMember(member: OrganizationMember) {
    if (!selectedOrgId) return;
    setBusy(member.id);
    try {
      await removeOrganizationMember(authedFetch, selectedOrgId, member.id);
      notify('success', t('txt_organizations_member_removed'));
      await refreshOrgDetail(selectedOrgId);
      await onRefreshVault();
    } catch (err) {
      notify('error', err instanceof Error ? err.message : t('txt_organizations_member_remove_failed'));
    } finally {
      setBusy(null);
    }
  }

  async function handleCreateCollection() {
    if (!selectedOrgId || !orgKeys?.[selectedOrgId]) return;
    const name = newCollectionName.trim();
    if (!name) {
      notify('warning', t('txt_organizations_collection_name_required'));
      return;
    }
    setBusy('new-collection');
    try {
      const material = orgKeys[selectedOrgId];
      const encName = await encryptWithOrgKey(name, {
        encB64: material.encB64,
        macB64: material.macB64,
        encBytes: base64ToBytes(material.encB64),
        macBytes: base64ToBytes(material.macB64),
      });
      await createOrganizationCollection(authedFetch, selectedOrgId, encName);
      setNewCollectionName('');
      notify('success', t('txt_organizations_collection_created'));
      await refreshOrgDetail(selectedOrgId);
      await onRefreshVault();
    } catch (err) {
      notify('error', err instanceof Error ? err.message : t('txt_organizations_collection_create_failed'));
    } finally {
      setBusy(null);
    }
  }

  async function handleDeleteCollection(collection: OrganizationCollection) {
    if (!selectedOrgId) return;
    setBusy(collection.id);
    try {
      await deleteOrganizationCollection(authedFetch, selectedOrgId, collection.id);
      notify('success', t('txt_organizations_collection_deleted'));
      await refreshOrgDetail(selectedOrgId);
      await onRefreshVault();
    } catch (err) {
      notify('error', err instanceof Error ? err.message : t('txt_organizations_collection_delete_failed'));
    } finally {
      setBusy(null);
    }
  }

  async function handleToggleMemberAccessAll(member: OrganizationMember) {
    if (!selectedOrgId) return;
    setBusy(member.id);
    try {
      await updateOrganizationMember(authedFetch, selectedOrgId, member.id, {
        accessAll: !member.accessAll,
      });
      await refreshOrgDetail(selectedOrgId);
      await onRefreshVault();
    } catch (err) {
      notify('error', err instanceof Error ? err.message : t('txt_organizations_member_update_failed'));
    } finally {
      setBusy(null);
    }
  }

  // Per-collection permission editor: seed a row per org collection from the
  // member's current access, then replace the whole set on save.
  async function openMemberPermissions(member: OrganizationMember) {
    if (!selectedOrgId || !orgKeys?.[selectedOrgId]) return;
    try {
      const details = await getOrganizationMember(authedFetch, selectedOrgId, member.id);
      const assigned = new Map(
        (details.collections || []).map((row) => [row.id, row])
      );
      const rows = collections.map((collection) => {
        const existing = assigned.get(collection.id);
        return {
          id: collection.id,
          name: collectionNames[collection.id] || collection.id.slice(0, 8),
          enabled: !!existing,
          readOnly: !!existing?.readOnly,
          hidePasswords: !!existing?.hidePasswords,
        };
      });
      setPermissionsRows(rows);
      setPermissionsMember(member);
    } catch (err) {
      notify('error', err instanceof Error ? err.message : t('txt_organizations_member_update_failed'));
    }
  }

  async function saveMemberPermissions() {
    if (!selectedOrgId || !permissionsMember) return;
    setPermissionsSubmitting(true);
    try {
      const collectionsPayload = permissionsRows
        .filter((row) => row.enabled)
        .map((row) => ({ id: row.id, readOnly: row.readOnly, hidePasswords: row.hidePasswords }));
      await updateOrganizationMember(authedFetch, selectedOrgId, permissionsMember.id, {
        accessAll: false,
        collections: collectionsPayload,
      });
      notify('success', t('txt_organizations_permissions_saved'));
      setPermissionsMember(null);
      setPermissionsRows([]);
      await refreshOrgDetail(selectedOrgId);
      await onRefreshVault();
    } catch (err) {
      notify('error', err instanceof Error ? err.message : t('txt_organizations_member_update_failed'));
    } finally {
      setPermissionsSubmitting(false);
    }
  }

  async function handleRenameOrganization() {
    if (!selectedOrgId || !orgKeys?.[selectedOrgId] || !selectedOrganization) return;
    const material = orgKeys[selectedOrgId];
    const current = displayNames[selectedOrgId] || '';
    const next = window.prompt(t('txt_organizations_rename_prompt'), current);
    if (!next || next.trim() === current) return;
    setBusy('rename');
    try {
      const encName = await encryptWithOrgKey(next.trim(), {
        encB64: material.encB64,
        macB64: material.macB64,
        encBytes: base64ToBytes(material.encB64),
        macBytes: base64ToBytes(material.macB64),
      });
      await updateOrganization(authedFetch, selectedOrgId, encName);
      notify('success', t('txt_organizations_renamed'));
      await refreshOrganizations();
      await onRefreshVault();
    } catch (err) {
      notify('error', err instanceof Error ? err.message : t('txt_organizations_rename_failed'));
    } finally {
      setBusy(null);
    }
  }

  async function handleLeaveOrganization() {
    if (!selectedOrgId) return;
    if (!window.confirm(t('txt_organizations_leave_confirm'))) return;
    setBusy('leave');
    try {
      await leaveOrganization(authedFetch, selectedOrgId);
      notify('success', t('txt_organizations_left'));
      setSelectedOrgId(null);
      await refreshOrganizations();
      await onRefreshVault();
    } catch (err) {
      notify('error', err instanceof Error ? err.message : t('txt_organizations_leave_failed'));
    } finally {
      setBusy(null);
    }
  }

  async function handleDeleteOrganization() {
    if (!selectedOrgId) return;
    if (!window.confirm(t('txt_organizations_delete_confirm'))) return;
    setBusy('delete-org');
    try {
      await deleteOrganization(authedFetch, selectedOrgId);
      notify('success', t('txt_organizations_deleted'));
      setSelectedOrgId(null);
      await refreshOrganizations();
      await onRefreshVault();
    } catch (err) {
      notify('error', err instanceof Error ? err.message : t('txt_organizations_delete_failed'));
    } finally {
      setBusy(null);
    }
  }

  function statusLabel(status: number): string {
    if (status === STATUS_INVITED) return t('txt_organizations_status_invited');
    if (status === STATUS_ACCEPTED) return t('txt_organizations_status_accepted');
    if (status === STATUS_CONFIRMED) return t('txt_organizations_status_confirmed');
    return String(status);
  }

  const pendingInvitations = organizations.filter(
    (org) => Number(org.status) === STATUS_INVITED || Number(org.status) === STATUS_ACCEPTED
  );
  const confirmedOrganizations = organizations.filter((org) => Number(org.status) === STATUS_CONFIRMED);

  return (
    <div className="stack">
      {!!error && (
        <div className="local-error">
          <span>{error}</span>
          <button type="button" className="btn btn-secondary small" onClick={() => void refreshOrganizations()}>
            <RefreshCw size={14} className="btn-icon" />
            {t('txt_refresh')}
          </button>
        </div>
      )}

      {pendingInvitations.length > 0 && (
        <section className="card">
          <div className="section-head">
            <h3>{t('txt_organizations_pending_invitations')}</h3>
          </div>
          <table className="table">
            <thead>
              <tr>
                <th>{t('txt_organizations_invited_by')}</th>
                <th>{t('txt_status')}</th>
                <th>{t('txt_actions')}</th>
              </tr>
            </thead>
            <tbody>
              {pendingInvitations.map((org) => (
                <tr key={org.id}>
                  <td>{org.ownerEmail || '-'}</td>
                  <td>{statusLabel(Number(org.status))}</td>
                  <td>
                    {Number(org.status) === STATUS_INVITED ? (
                      <button
                        type="button"
                        className="btn btn-primary small"
                        disabled={busy === org.id}
                        onClick={() => void handleAcceptInvitation(org)}
                      >
                        {t('txt_organizations_accept')}
                      </button>
                    ) : (
                      <span className="muted">{t('txt_organizations_awaiting_confirmation')}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section className="card">
        <div className="section-head">
          <h3>{t('txt_organizations_title')}</h3>
        </div>
        <div className="org-create-row">
          <input
            type="text"
            className="input"
            placeholder={t('txt_organizations_name_placeholder')}
            value={createName}
            onInput={(event) => setCreateName((event.target as HTMLInputElement).value)}
          />
          <button type="button" className="btn btn-primary" disabled={creating} onClick={() => void handleCreateOrganization()}>
            <Plus size={14} className="btn-icon" />
            {creating ? t('txt_creating') : t('txt_organizations_create')}
          </button>
        </div>
        <p className="muted small-note">{t('txt_organizations_create_note')}</p>

        {loading ? (
          <p className="muted">{t('txt_loading')}</p>
        ) : confirmedOrganizations.length === 0 ? (
          <p className="muted">{t('txt_organizations_none')}</p>
        ) : (
          <div className="org-list">
            {confirmedOrganizations.map((org) => (
              <button
                key={org.id}
                type="button"
                className={`org-list-item ${selectedOrgId === org.id ? 'active' : ''}`}
                onClick={() => setSelectedOrgId(org.id === selectedOrgId ? null : org.id)}
              >
                <span className="org-list-name">{displayNames[org.id] || org.id.slice(0, 8)}</span>
                {Number(org.type) === TYPE_OWNER && <span className="badge">{t('txt_organizations_owner_badge')}</span>}
              </button>
            ))}
          </div>
        )}
      </section>

      {selectedOrganization && Number(selectedOrganization.status) === STATUS_CONFIRMED && (
        <section className="card">
          <div className="section-head">
            <h3>
              {displayNames[selectedOrganization.id] || selectedOrganization.id.slice(0, 8)}
              {orgKeys?.[selectedOrganization.id] ? '' : ` (${t('txt_organizations_key_unavailable')})`}
            </h3>
            <div className="section-head-actions">
              <button type="button" className="btn btn-secondary small" disabled={busy === 'rename'} onClick={() => void handleRenameOrganization()}>
                {t('txt_organizations_rename')}
              </button>
              <button type="button" className="btn btn-secondary small" disabled={busy === 'leave'} onClick={() => void handleLeaveOrganization()}>
                {t('txt_organizations_leave')}
              </button>
              {selectedIsOwner && (
                <button type="button" className="btn btn-danger small" disabled={busy === 'delete-org'} onClick={() => void handleDeleteOrganization()}>
                  <Trash2 size={14} className="btn-icon" />
                  {t('txt_organizations_delete')}
                </button>
              )}
            </div>
          </div>

          {!orgKeys?.[selectedOrganization.id] ? (
            <p className="muted">{t('txt_organizations_key_unavailable_note')}</p>
          ) : (
            <>
              {selectedIsOwner && (
                <div className="org-section">
                  <h4>{t('txt_organizations_invite_members')}</h4>
                  <div className="org-create-row">
                    <input
                      type="text"
                      className="input"
                      placeholder={t('txt_organizations_invite_emails_placeholder')}
                      value={inviteEmails}
                      onInput={(event) => setInviteEmails((event.target as HTMLInputElement).value)}
                    />
                    <button type="button" className="btn btn-primary" disabled={inviteSubmitting} onClick={() => void handleInvite()}>
                      {inviteSubmitting ? t('txt_sending') : t('txt_organizations_invite')}
                    </button>
                  </div>
                  <label className="checkbox-row">
                    <input
                      type="checkbox"
                      checked={inviteAccessAll}
                      onChange={(event) => setInviteAccessAll((event.target as HTMLInputElement).checked)}
                    />
                    {t('txt_organizations_invite_access_all')}
                  </label>
                </div>
              )}

              <div className="org-section">
                <h4>{t('txt_organizations_members')}</h4>
                {detailLoading ? (
                  <p className="muted">{t('txt_loading')}</p>
                ) : (
                  <table className="table">
                    <thead>
                      <tr>
                        <th>{t('txt_email')}</th>
                        <th>{t('txt_organizations_role')}</th>
                        <th>{t('txt_status')}</th>
                        <th>{t('txt_organizations_access')}</th>
                        <th>{t('txt_actions')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {members.map((member) => (
                        <tr key={member.id}>
                          <td>{member.email}</td>
                          <td>{Number(member.type) === TYPE_OWNER ? t('txt_organizations_owner_badge') : t('txt_organizations_member_badge')}</td>
                          <td>{statusLabel(Number(member.status))}</td>
                          <td>
                            {Number(member.status) === STATUS_CONFIRMED ? (
                              <label className="checkbox-row">
                                <input
                                  type="checkbox"
                                  checked={!!member.accessAll}
                                  disabled={busy === member.id}
                                  onChange={() => void handleToggleMemberAccessAll(member)}
                                />
                                {t('txt_organizations_access_all')}
                              </label>
                            ) : (
                              '-'
                            )}
                          </td>
                          <td>
                            {selectedIsOwner && Number(member.status) === STATUS_CONFIRMED && (
                              <button
                                type="button"
                                className="btn btn-secondary small"
                                disabled={busy === member.id}
                                onClick={() => void openMemberPermissions(member)}
                              >
                                <SlidersHorizontal size={14} className="btn-icon" />
                                {t('txt_organizations_permissions')}
                              </button>
                            )}
                            {selectedIsOwner && Number(member.status) === STATUS_ACCEPTED && (
                              <button
                                type="button"
                                className="btn btn-primary small"
                                disabled={busy === member.id}
                                onClick={() => void handleConfirmMember(member)}
                              >
                                {t('txt_organizations_confirm')}
                              </button>
                            )}
                            {selectedIsOwner && member.userId !== props.profile?.id && (
                              <button
                                type="button"
                                className="btn btn-danger small"
                                disabled={busy === member.id}
                                onClick={() => void handleRemoveMember(member)}
                              >
                                {t('txt_organizations_remove')}
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>

              <div className="org-section">
                <h4>{t('txt_organizations_collections')}</h4>
                <div className="org-create-row">
                  <input
                    type="text"
                    className="input"
                    placeholder={t('txt_organizations_collection_name_placeholder')}
                    value={newCollectionName}
                    onInput={(event) => setNewCollectionName((event.target as HTMLInputElement).value)}
                  />
                  <button type="button" className="btn btn-primary" disabled={busy === 'new-collection'} onClick={() => void handleCreateCollection()}>
                    <Plus size={14} className="btn-icon" />
                    {t('txt_organizations_add_collection')}
                  </button>
                </div>
                {detailLoading ? (
                  <p className="muted">{t('txt_loading')}</p>
                ) : (
                  <ul className="org-collections">
                    {collections.map((collection) => (
                      <li key={collection.id} className="org-collection-row">
                        <span>{collectionNames[collection.id] || collection.id.slice(0, 8)}</span>
                        {selectedIsOwner && (
                          <button
                            type="button"
                            className="btn btn-danger small"
                            disabled={busy === collection.id}
                            onClick={() => void handleDeleteCollection(collection)}
                          >
                            <Trash2 size={14} className="btn-icon" />
                            {t('txt_delete')}
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </>
          )}
        </section>
      )}

      <ConfirmDialog
        open={!!permissionsMember}
        title={t('txt_organizations_permissions_title', { email: permissionsMember?.email || '' })}
        message={t('txt_organizations_permissions_hint')}
        confirmText={t('txt_save')}
        cancelText={t('txt_cancel')}
        confirmDisabled={permissionsSubmitting}
        cancelDisabled={permissionsSubmitting}
        onConfirm={() => void saveMemberPermissions()}
        onCancel={() => {
          setPermissionsMember(null);
          setPermissionsRows([]);
        }}
      >
        <div className="org-permissions-rows">
          {permissionsRows.length === 0 && (
            <p className="muted">{t('txt_organizations_no_collections')}</p>
          )}
          {permissionsRows.map((row) => (
            <div key={row.id} className="org-permission-row">
              <label className="checkbox-row org-permission-enable">
                <input
                  type="checkbox"
                  checked={row.enabled}
                  onChange={(event) => setPermissionsRows((rows) => rows.map((item) => (
                    item.id === row.id ? { ...item, enabled: (event.target as HTMLInputElement).checked } : item
                  )))}
                />
                <span className="org-permission-name">{row.name}</span>
              </label>
              {row.enabled && (
                <div className="org-permission-flags">
                  <label className="checkbox-row">
                    <input
                      type="checkbox"
                      checked={row.readOnly}
                      onChange={(event) => setPermissionsRows((rows) => rows.map((item) => (
                        item.id === row.id ? { ...item, readOnly: (event.target as HTMLInputElement).checked } : item
                      )))}
                    />
                    {t('txt_organizations_readonly_badge')}
                  </label>
                  <label className="checkbox-row">
                    <input
                      type="checkbox"
                      checked={row.hidePasswords}
                      onChange={(event) => setPermissionsRows((rows) => rows.map((item) => (
                        item.id === row.id ? { ...item, hidePasswords: (event.target as HTMLInputElement).checked } : item
                      )))}
                    />
                    {t('txt_organizations_hide_passwords')}
                  </label>
                </div>
              )}
            </div>
          ))}
        </div>
      </ConfirmDialog>
    </div>
  );
}
