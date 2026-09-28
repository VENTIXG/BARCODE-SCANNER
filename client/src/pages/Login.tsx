import { useState } from 'react';
import { Warehouse } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { useI18n } from '../lib/i18n';
import { Button, ErrorBox, Field, Input } from '../components/ui';

export function LoginPage() {
  const { t, lang, setLang } = useI18n();
  const { login } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await login(username, password);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-full items-center justify-center bg-bg px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center text-center">
          <div className="mb-3 flex size-12 items-center justify-center rounded-xl bg-brand text-white shadow-lg shadow-brand/20">
            <Warehouse className="size-6" />
          </div>
          <h1 className="text-xl font-semibold text-fg">Warehouse IMS</h1>
          <p className="mt-1 text-sm text-muted">{t('Sign in to continue')}</p>
        </div>
        <form onSubmit={submit} className="space-y-4 rounded-2xl border border-line bg-surface p-6 shadow-sm">
          <Field label={t('Username')}>
            <Input autoFocus autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required />
          </Field>
          <Field label={t('Password')}>
            <Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </Field>
          <ErrorBox error={error} />
          <Button type="submit" variant="primary" className="w-full" size="lg" loading={loading}>
            {t('Sign in')}
          </Button>
        </form>
        <div className="mt-4 text-center">
          <button onClick={() => setLang(lang === 'el' ? 'en' : 'el')} className="text-xs text-muted hover:text-fg">
            {lang === 'el' ? 'English' : 'Ελληνικά'}
          </button>
        </div>
      </div>
    </div>
  );
}
