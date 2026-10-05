import { useEffect, useState } from 'preact/hooks';
import { Clipboard, RefreshCw } from 'lucide-preact';
import ConfirmDialog from '@/components/ConfirmDialog';
import { copyTextToClipboard } from '@/lib/clipboard';
import {
  getMemberRegistrationCode,
  remintMemberRegistrationCode,
  type MemberRegistrationCode,
} from '@/lib/api/organizations';
import type { AuthedFetch } from '@/lib/api/shared';
import type { OrganizationMember } from '@/lib/api/organizations';
import { t } from '@/lib/i18n';

interface RegistrationCodeDialogProps {
  open: boolean;
  authedFetch: AuthedFetch;
  organizationId: string | null;
  member: OrganizationMember | null;
  onClose: () => void;
}

// Owner-facing view of a pending (invited, unlinked) member's registration
// code: shows the active code and shareable link, with a re-mint action that
// rotates the code (the old one is revoked server-side). Codes were
// previously only visible in the admin panel, which an organization owner who
// is not the server admin cannot access.
export default function OrganizationRegistrationCodeDialog(props: RegistrationCodeDialogProps) {
  const [code, setCode] = useState<MemberRegistrationCode | null>(null);
  const [loading, setLoading] = useState(false);
  const [reminting, setReminting] = useState(false);
  const [error, setError] = useState('');

  const member = props.member;
  const open = props.open && !!member && !!props.organizationId;

  useEffect(() => {
    if (!open || !member || !props.organizationId) return;
    let cancelled = false;
    setLoading(true);
    setError('');
    setCode(null);
    getMemberRegistrationCode(props.authedFetch, props.organizationId, member.id)
      .then((next) => {
        if (!cancelled) setCode(next);
      })
      .catch(() => {
        if (!cancelled) setError(t('txt_organizations_reg_code_failed'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, member?.id, props.organizationId, props.authedFetch]);

  async function handleRemint() {
    if (!member || !props.organizationId || reminting) return;
    setReminting(true);
    setError('');
    try {
      const next = await remintMemberRegistrationCode(props.authedFetch, props.organizationId, member.id);
      setCode({
        inviteCode: next.inviteCode,
        inviteLink: next.inviteLink,
        expiresAt: next.expiresAt,
        reason: null,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : t('txt_organizations_reg_code_failed'));
    } finally {
      setReminting(false);
    }
  }

  return (
    <ConfirmDialog
      open={open}
      title={t('txt_organizations_reg_code_title')}
      message={member?.email || ''}
      hideConfirm
      hideCancel
      closeButton
      onConfirm={() => {}}
      onCancel={props.onClose}
    >
      {loading && <div className="empty">{t('txt_loading')}</div>}
      {!loading && error && <div className="empty">{error}</div>}
      {!loading && !error && code && (
        <>
          {code.reason === 'email_registered' ? (
            <div className="empty">{t('txt_organizations_reg_code_email_registered')}</div>
          ) : code.inviteCode ? (
            <>
              <div className="field">
                <span>{t('txt_code')}</span>
                <div className="input-action-wrap">
                  <input className="input" readonly value={code.inviteCode} />
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => void copyTextToClipboard(code.inviteCode || '', { successMessage: t('txt_code_copied') })}
                  >
                    <Clipboard size={14} className="btn-icon" /> {t('txt_copy_code')}
                  </button>
                </div>
              </div>
              <div className="field">
                <span>{t('txt_organizations_reg_code_link')}</span>
                <div className="input-action-wrap">
                  <input className="input" readonly value={code.inviteLink || ''} />
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => void copyTextToClipboard(code.inviteLink || '', { successMessage: t('txt_link_copied') })}
                  >
                    <Clipboard size={14} className="btn-icon" /> {t('txt_copy_link')}
                  </button>
                </div>
              </div>
              {code.expiresAt && (
                <div className="field-help">{t('txt_organizations_reg_code_expires', { date: code.expiresAt.slice(0, 10) })}</div>
              )}
              <div className="field-help">{t('txt_organizations_reg_code_note')}</div>
              <div className="actions">
                <button type="button" className="btn btn-secondary" disabled={reminting} onClick={() => void handleRemint()}>
                  <RefreshCw size={14} className="btn-icon" /> {t('txt_organizations_reg_code_new')}
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="empty">{t('txt_organizations_reg_code_none')}</div>
              <div className="actions">
                <button type="button" className="btn btn-secondary" disabled={reminting} onClick={() => void handleRemint()}>
                  <RefreshCw size={14} className="btn-icon" /> {t('txt_organizations_reg_code_new')}
                </button>
              </div>
            </>
          )}
        </>
      )}
    </ConfirmDialog>
  );
}
