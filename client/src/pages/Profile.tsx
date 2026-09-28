import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useT } from '../lib/i18n';
import { errMsg } from '../lib/queries';
import { Button, Card, CardHeader, ErrorBox, Field, Input, PageHeader } from '../components/ui';

export default function Profile() {
  const t = useT();
  const { user } = useAuth();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const m = useMutation({
    mutationFn: () => api.post('/auth/change-password', { currentPassword: current, newPassword: next }),
    onSuccess: () => {
      toast.success(t('Password changed. Other sessions have been signed out.'));
      setCurrent('');
      setNext('');
      setConfirm('');
    },
  });
  const mismatch = confirm.length > 0 && next !== confirm;
  const valid = current && next.length >= 8 && next === confirm;
  return (
    <div className="mx-auto max-w-lg">
      <PageHeader title={t('My account')} subtitle={`${user?.fullName} · ${user?.username}`} />
      <Card>
        <CardHeader title={t('Change password')} />
        <form className="space-y-3 p-4" onSubmit={(e) => (e.preventDefault(), valid && m.mutate())}>
          <Field label={t('Current password')}><Input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} /></Field>
          <Field label={t('New password')} hint={t('At least 8 characters')}><Input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} /></Field>
          <Field label={t('Confirm new password')} error={mismatch ? t('Passwords do not match') : undefined}>
            <Input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} invalid={mismatch} />
          </Field>
          <ErrorBox error={m.error ? errMsg(m.error) : null} />
          <div className="flex justify-end">
            <Button type="submit" variant="primary" disabled={!valid} loading={m.isPending}>{t('Change password')}</Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
