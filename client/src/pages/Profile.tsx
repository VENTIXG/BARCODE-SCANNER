import { useAuth } from '../lib/auth';
import { useT } from '../lib/i18n';
import { ChangePasswordForm } from '../components/ChangePasswordForm';
import { Card, CardHeader, PageHeader } from '../components/ui';

export default function Profile() {
  const t = useT();
  const { user } = useAuth();
  return (
    <div className="mx-auto max-w-lg">
      <PageHeader title={t('My account')} subtitle={`${user?.fullName} · ${user?.username}`} />
      <Card>
        <CardHeader title={t('Change password')} />
        <ChangePasswordForm />
      </Card>
    </div>
  );
}
