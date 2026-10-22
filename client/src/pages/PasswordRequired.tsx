import { KeyRound } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { useT } from '../lib/i18n';
import { ChangePasswordForm } from '../components/ChangePasswordForm';

/**
 * Signed in with a temporary password (the first default one, or one an administrator set):
 * the server allows nothing else until the user chooses their own.
 */
export function PasswordRequired() {
  const t = useT();
  const { user, logout } = useAuth();
  return (
    <div className="flex min-h-full items-center justify-center bg-bg px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center text-center">
          <div className="mb-3 flex size-12 items-center justify-center rounded-xl bg-warn-soft text-warn">
            <KeyRound className="size-6" />
          </div>
          <h1 className="text-xl font-semibold text-fg">{t('Choose your own password')}</h1>
          <p className="mt-1 text-sm text-muted">
            {t('{user}, you signed in with a temporary password. Choose your own to continue, so nobody else can sign in as you.', { user: user?.username ?? '' })}
          </p>
        </div>
        <div className="rounded-2xl border border-line bg-surface shadow-sm">
          <ChangePasswordForm submitLabel={t('Save and continue')} />
        </div>
        <button type="button" onClick={() => void logout()} className="mt-4 w-full text-center text-sm text-muted underline hover:text-fg">
          {t('Sign out')}
        </button>
      </div>
    </div>
  );
}
