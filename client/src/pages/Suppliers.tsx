import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Download, Mail, Pencil, Phone, Plus, Trash2, Truck } from 'lucide-react';
import { toast } from 'sonner';
import { api, download } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDate, fmtMoney, fmtNumber } from '../lib/format';
import { useT } from '../lib/i18n';
import { errMsg, useSuppliers } from '../lib/queries';
import type { Supplier } from '../lib/types';
import { Badge, Button, Card, Checkbox, ConfirmDialog, EmptyState, ErrorBox, Field, IconButton, Input, LoadingBlock, Modal, PageHeader, Table, Td, Textarea, Th } from '../components/ui';

type Form = { id?: number; name: string; contactName: string; email: string; phone: string; address: string; vatNumber: string; notes: string; isActive: boolean };
const toForm = (s?: Supplier): Form => ({
  id: s?.id,
  name: s?.name ?? '',
  contactName: s?.contact_name ?? '',
  email: s?.email ?? '',
  phone: s?.phone ?? '',
  address: s?.address ?? '',
  vatNumber: s?.vat_number ?? '',
  notes: s?.notes ?? '',
  isActive: s ? Boolean(s.is_active) : true,
});

export default function Suppliers() {
  const t = useT();
  const { can } = useAuth();
  const qc = useQueryClient();
  const suppliers = useSuppliers();
  const [q, setQ] = useState('');
  const [form, setForm] = useState<Form | null>(null);
  const [del, setDel] = useState<Supplier | null>(null);

  const save = useMutation({
    mutationFn: (f: Form) => {
      const { id, ...body } = f;
      return id ? api.put(`/suppliers/${id}`, body) : api.post('/suppliers', body);
    },
    onSuccess: () => (toast.success(t('Supplier saved')), setForm(null), void qc.invalidateQueries({ queryKey: ['suppliers'] })),
  });
  const remove = useMutation({
    mutationFn: (id: number) => api.del(`/suppliers/${id}`),
    onSuccess: () => (toast.success(t('Supplier deleted')), setDel(null), void qc.invalidateQueries({ queryKey: ['suppliers'] })),
    onError: (e) => (toast.error(errMsg(e)), setDel(null)),
  });

  const rows = (suppliers.data ?? []).filter((s) => !q || [s.name, s.contact_name, s.email, s.vat_number].some((v) => v?.toLowerCase().includes(q.toLowerCase())));
  const set = (k: keyof Form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setForm((f) => f && { ...f, [k]: e.target.value });

  return (
    <div>
      <PageHeader
        title={t('Suppliers')}
        subtitle={t('{n} suppliers', { n: suppliers.data?.length ?? 0 })}
        actions={
          <>
            {can('export.run') && (
              <Button icon={<Download className="size-4" />} onClick={() => download('/export/grouped/supplier').catch((e) => toast.error(errMsg(e)))}>
                {t('Products by supplier')}
              </Button>
            )}
            {can('catalog.manage') && (
              <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setForm(toForm())}>
                {t('New supplier')}
              </Button>
            )}
          </>
        }
      />
      <Card>
        <div className="border-b border-line p-3">
          <Input className="w-full sm:w-72" placeholder={t('Search suppliers…')} value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        {suppliers.isLoading ? (
          <LoadingBlock />
        ) : rows.length === 0 ? (
          <EmptyState icon={<Truck className="size-5" />} title={t('No suppliers')} />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>{t('Supplier')}</Th>
                <Th className="hidden md:table-cell">{t('Contact')}</Th>
                <Th className="hidden lg:table-cell">{t('VAT number')}</Th>
                <Th align="right">{t('Products')}</Th>
                <Th align="right" className="hidden sm:table-cell">{t('Stock value')}</Th>
                <Th className="hidden lg:table-cell">{t('Last receipt')}</Th>
                <Th>{t('Status')}</Th>
                {can('catalog.manage') && <Th />}
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.id} className="hover:bg-surface-2">
                  <Td>
                    <Link to={`/products?supplierId=${s.id}`} className="font-medium hover:underline">{s.name}</Link>
                    {s.address && <div className="max-w-[260px] truncate text-xs text-muted">{s.address}</div>}
                  </Td>
                  <Td className="hidden text-xs md:table-cell">
                    <div className="text-sm">{s.contact_name ?? '—'}</div>
                    {s.phone && <div className="flex items-center gap-1 text-muted"><Phone className="size-3" /> {s.phone}</div>}
                    {s.email && <a href={`mailto:${s.email}`} className="flex items-center gap-1 text-brand-fg hover:underline"><Mail className="size-3" /> {s.email}</a>}
                  </Td>
                  <Td className="hidden font-mono text-xs lg:table-cell">{s.vat_number ?? '—'}</Td>
                  <Td align="right" className="tabular">{fmtNumber(s.product_count)}</Td>
                  <Td align="right" className="tabular hidden sm:table-cell">{fmtMoney(s.stock_value)}</Td>
                  <Td className="hidden lg:table-cell">{fmtDate(s.last_receipt_date)}</Td>
                  <Td>{s.is_active ? <Badge tone="brand">{t('Active')}</Badge> : <Badge>{t('Inactive')}</Badge>}</Td>
                  {can('catalog.manage') && (
                    <Td align="right" className="whitespace-nowrap">
                      <IconButton label={t('Edit')} onClick={() => setForm(toForm(s))}><Pencil className="size-4" /></IconButton>
                      <IconButton label={t('Delete')} onClick={() => setDel(s)}><Trash2 className="size-4" /></IconButton>
                    </Td>
                  )}
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Modal
        open={Boolean(form)}
        onClose={() => setForm(null)}
        title={form?.id ? t('Edit supplier') : t('New supplier')}
        footer={
          <>
            <Button onClick={() => setForm(null)}>{t('Cancel')}</Button>
            <Button variant="primary" disabled={!form?.name.trim()} loading={save.isPending} onClick={() => form && save.mutate(form)}>{t('Save')}</Button>
          </>
        }
      >
        {form && (
          <form className="grid gap-3 sm:grid-cols-2" onSubmit={(e) => (e.preventDefault(), form.name.trim() && save.mutate(form))}>
            <Field label={t('Name')} required className="sm:col-span-2"><Input value={form.name} onChange={set('name')} /></Field>
            <Field label={t('Contact person')}><Input value={form.contactName} onChange={set('contactName')} /></Field>
            <Field label={t('Phone')}><Input value={form.phone} onChange={set('phone')} /></Field>
            <Field label="Email"><Input type="email" value={form.email} onChange={set('email')} /></Field>
            <Field label={t('VAT number')}><Input value={form.vatNumber} onChange={set('vatNumber')} /></Field>
            <Field label={t('Address')} className="sm:col-span-2"><Input value={form.address} onChange={set('address')} /></Field>
            <Field label={t('Notes')} className="sm:col-span-2"><Textarea value={form.notes} onChange={set('notes')} rows={2} /></Field>
            <div className="sm:col-span-2"><Checkbox checked={form.isActive} onChange={(v) => setForm({ ...form, isActive: v })} label={t('Active')} /></div>
            <div className="sm:col-span-2"><ErrorBox error={save.error ? errMsg(save.error) : null} /></div>
            <button type="submit" hidden />
          </form>
        )}
      </Modal>
      <ConfirmDialog
        open={Boolean(del)}
        title={t('Delete supplier "{name}"?', { name: del?.name })}
        message={t('Products of this supplier are kept, without a supplier.')}
        confirmLabel={t('Delete')}
        tone="danger"
        loading={remove.isPending}
        onConfirm={() => del && remove.mutate(del.id)}
        onClose={() => setDel(null)}
      />
    </div>
  );
}
