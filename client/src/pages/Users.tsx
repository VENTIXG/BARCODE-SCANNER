import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDateTime } from '../lib/format';
import { useT } from '../lib/i18n';
import { errMsg } from '../lib/queries';
import type { Role, UserRow } from '../lib/types';
import { Badge, Button, Card, Checkbox, ErrorBox, Field, IconButton, Input, LoadingBlock, Modal, PageHeader, Select, Table, Td, Th } from '../components/ui';

type Form = { id?: number; username: string; fullName: string; email: string; role: Role; isActive: boolean; password: string };

const ROLE_INFO: Record<Role, { label: string; desc: string; tone: 'brand' | 'ok' | 'neutral' }> = {
  ADMIN: { label: 'Administrator', desc: 'Full access, including users and settings.', tone: 'brand' },
  MANAGER: { label: 'Manager', desc: 'Products, inventory, adjustments, import/export and reports.', tone: 'ok' },
  WAREHOUSE_USER: { label: 'Warehouse user', desc: 'Barcode scanning, stock in / out and product lookup.', tone: 'neutral' },
};

export default function Users() {
  const t = useT();
  const qc = useQueryClient();
  const { user: me } = useAuth();
  const [form, setForm] = useState<Form | null>(null);
  const users = useQuery({ queryKey: ['users'], queryFn: () => api.get<{ data: UserRow[] }>('/users').then((r) => r.data) });

  const save = useMutation({
    mutationFn: (f: Form) => {
      const { id, ...body } = f;
      return id ? api.put(`/users/${id}`, body) : api.post('/users', body);
    },
    onSuccess: () => (toast.success(t('User saved')), setForm(null), void qc.invalidateQueries({ queryKey: ['users'] })),
  });

  const set = (k: keyof Form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm((f) => f && { ...f, [k]: e.target.value });
  const valid = form && form.username.trim().length >= 3 && form.fullName.trim() && (form.id ? !form.password || form.password.length >= 8 : form.password.length >= 8);

  return (
    <div>
      <PageHeader
        title={t('Users')}
        subtitle={t('Accounts and access roles')}
        actions={
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setForm({ username: '', fullName: '', email: '', role: 'WAREHOUSE_USER', isActive: true, password: '' })}>
            {t('New user')}
          </Button>
        }
      />
      <div className="mb-4 grid gap-3 md:grid-cols-3">
        {(Object.keys(ROLE_INFO) as Role[]).map((r) => (
          <Card key={r} className="flex gap-3 p-4">
            <ShieldCheck className="size-5 shrink-0 text-brand-fg" />
            <div>
              <div className="text-sm font-semibold">{t(ROLE_INFO[r].label)}</div>
              <div className="text-xs text-muted">{t(ROLE_INFO[r].desc)}</div>
            </div>
          </Card>
        ))}
      </div>
      <Card>
        {users.isLoading ? (
          <LoadingBlock />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>{t('User')}</Th>
                <Th>{t('Username')}</Th>
                <Th>{t('Role')}</Th>
                <Th className="hidden md:table-cell">Email</Th>
                <Th className="hidden lg:table-cell">{t('Last login')}</Th>
                <Th>{t('Status')}</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {users.data?.map((u) => (
                <tr key={u.id} className="hover:bg-surface-2">
                  <Td className="font-medium">{u.full_name} {u.id === me?.id && <span className="text-xs text-muted">({t('you')})</span>}</Td>
                  <Td className="font-mono text-xs">{u.username}</Td>
                  <Td><Badge tone={ROLE_INFO[u.role].tone}>{t(ROLE_INFO[u.role].label)}</Badge></Td>
                  <Td className="hidden text-fg-2 md:table-cell">{u.email ?? '—'}</Td>
                  <Td className="hidden text-xs lg:table-cell">{fmtDateTime(u.last_login_at)}</Td>
                  <Td>{u.is_active ? <Badge tone="ok">{t('Active')}</Badge> : <Badge>{t('Disabled')}</Badge>}</Td>
                  <Td align="right">
                    <IconButton
                      label={t('Edit')}
                      onClick={() => setForm({ id: u.id, username: u.username, fullName: u.full_name, email: u.email ?? '', role: u.role, isActive: Boolean(u.is_active), password: '' })}
                    >
                      <Pencil className="size-4" />
                    </IconButton>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      <Modal
        open={Boolean(form)}
        onClose={() => setForm(null)}
        title={form?.id ? t('Edit user') : t('New user')}
        footer={
          <>
            <Button onClick={() => setForm(null)}>{t('Cancel')}</Button>
            <Button variant="primary" disabled={!valid} loading={save.isPending} onClick={() => form && save.mutate(form)}>{t('Save')}</Button>
          </>
        }
      >
        {form && (
          <form className="grid gap-3 sm:grid-cols-2" onSubmit={(e) => (e.preventDefault(), valid && save.mutate(form))} autoComplete="off">
            <Field label={t('Full name')} required><Input value={form.fullName} onChange={set('fullName')} /></Field>
            <Field label={t('Username')} required hint={t('Letters, digits, . - _')}><Input value={form.username} onChange={set('username')} autoComplete="off" /></Field>
            <Field label="Email"><Input type="email" value={form.email} onChange={set('email')} /></Field>
            <Field label={t('Role')} required>
              <Select value={form.role} onChange={set('role')}>
                {(Object.keys(ROLE_INFO) as Role[]).map((r) => <option key={r} value={r}>{t(ROLE_INFO[r].label)}</option>)}
              </Select>
            </Field>
            <Field
              label={form.id ? t('New password') : t('Password')}
              required={!form.id}
              hint={form.id ? t('Leave empty to keep the current password') : t('At least 8 characters')}
              className="sm:col-span-2"
            >
              <Input type="password" value={form.password} onChange={set('password')} autoComplete="new-password" />
            </Field>
            <div className="sm:col-span-2">
              <Checkbox checked={form.isActive} onChange={(v) => setForm({ ...form, isActive: v })} label={t('Account active')} description={t('Disabled users cannot sign in; their history is kept.')} />
            </div>
            <div className="sm:col-span-2"><ErrorBox error={save.error ? errMsg(save.error) : null} /></div>
            <button type="submit" hidden />
          </form>
        )}
      </Modal>
    </div>
  );
}
