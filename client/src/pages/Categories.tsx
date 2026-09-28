import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Download, Pencil, Plus, Tags, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { api, download } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtMoney, fmtNumber, fmtQty } from '../lib/format';
import { useT } from '../lib/i18n';
import { errMsg, useCategories } from '../lib/queries';
import type { Category } from '../lib/types';
import { Button, Card, ConfirmDialog, EmptyState, ErrorBox, Field, IconButton, Input, LoadingBlock, Modal, PageHeader, Table, Td, Textarea, Th } from '../components/ui';

export default function Categories() {
  const t = useT();
  const { can } = useAuth();
  const qc = useQueryClient();
  const categories = useCategories();
  const [form, setForm] = useState<{ id?: number; name: string; description: string } | null>(null);
  const [del, setDel] = useState<Category | null>(null);

  const save = useMutation({
    mutationFn: (f: { id?: number; name: string; description: string }) =>
      f.id ? api.put(`/categories/${f.id}`, { name: f.name, description: f.description }) : api.post('/categories', { name: f.name, description: f.description }),
    onSuccess: () => (toast.success(t('Category saved')), setForm(null), void qc.invalidateQueries({ queryKey: ['categories'] })),
  });
  const remove = useMutation({
    mutationFn: (id: number) => api.del(`/categories/${id}`),
    onSuccess: () => (toast.success(t('Category deleted')), setDel(null), void qc.invalidateQueries({ queryKey: ['categories'] })),
    onError: (e) => (toast.error(errMsg(e)), setDel(null)),
  });

  const total = (categories.data ?? []).reduce((s, c) => s + c.stock_value, 0);

  return (
    <div>
      <PageHeader
        title={t('Categories')}
        subtitle={t('{n} categories', { n: categories.data?.length ?? 0 })}
        actions={
          <>
            {can('export.run') && (
              <Button icon={<Download className="size-4" />} onClick={() => download('/export/grouped/category').catch((e) => toast.error(errMsg(e)))}>
                {t('Products by category')}
              </Button>
            )}
            {can('catalog.manage') && (
              <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setForm({ name: '', description: '' })}>
                {t('New category')}
              </Button>
            )}
          </>
        }
      />
      <Card>
        {categories.isLoading ? (
          <LoadingBlock />
        ) : !categories.data?.length ? (
          <EmptyState icon={<Tags className="size-5" />} title={t('No categories')} />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>{t('Category')}</Th>
                <Th className="hidden md:table-cell">{t('Description')}</Th>
                <Th align="right">{t('Products')}</Th>
                <Th align="right" className="hidden sm:table-cell">{t('Units')}</Th>
                <Th align="right">{t('Stock value')}</Th>
                <Th className="hidden lg:table-cell">{t('Share of value')}</Th>
                {can('catalog.manage') && <Th />}
              </tr>
            </thead>
            <tbody>
              {categories.data.map((c) => {
                const share = total > 0 ? (c.stock_value / total) * 100 : 0;
                return (
                  <tr key={c.id} className="hover:bg-surface-2">
                    <Td><Link to={`/products?categoryId=${c.id}`} className="font-medium hover:underline">{c.name}</Link></Td>
                    <Td className="hidden text-fg-2 md:table-cell">{c.description ?? ''}</Td>
                    <Td align="right" className="tabular">{fmtNumber(c.product_count)}</Td>
                    <Td align="right" className="tabular hidden sm:table-cell">{fmtQty(c.total_quantity)}</Td>
                    <Td align="right" className="tabular">{fmtMoney(c.stock_value)}</Td>
                    <Td className="hidden w-48 lg:table-cell">
                      <div className="flex items-center gap-2">
                        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-3">
                          <div className="h-full rounded-full bg-[var(--chart-1)]" style={{ width: `${share}%` }} />
                        </div>
                        <span className="tabular w-10 text-right text-xs text-muted">{share.toFixed(0)}%</span>
                      </div>
                    </Td>
                    {can('catalog.manage') && (
                      <Td align="right" className="whitespace-nowrap">
                        <IconButton label={t('Edit')} onClick={() => setForm({ id: c.id, name: c.name, description: c.description ?? '' })}><Pencil className="size-4" /></IconButton>
                        <IconButton label={t('Delete')} onClick={() => setDel(c)}><Trash2 className="size-4" /></IconButton>
                      </Td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>
      <Modal
        open={Boolean(form)}
        onClose={() => setForm(null)}
        size="sm"
        title={form?.id ? t('Edit category') : t('New category')}
        footer={
          <>
            <Button onClick={() => setForm(null)}>{t('Cancel')}</Button>
            <Button variant="primary" disabled={!form?.name.trim()} loading={save.isPending} onClick={() => form && save.mutate(form)}>{t('Save')}</Button>
          </>
        }
      >
        {form && (
          <form className="space-y-3" onSubmit={(e) => (e.preventDefault(), form.name.trim() && save.mutate(form))}>
            <Field label={t('Name')} required><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
            <Field label={t('Description')}><Textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} rows={2} /></Field>
            <ErrorBox error={save.error ? errMsg(save.error) : null} />
            <button type="submit" hidden />
          </form>
        )}
      </Modal>
      <ConfirmDialog
        open={Boolean(del)}
        title={t('Delete category "{name}"?', { name: del?.name })}
        message={t('{n} products will be left without a category.', { n: del?.product_count ?? 0 })}
        confirmLabel={t('Delete')}
        tone="danger"
        loading={remove.isPending}
        onConfirm={() => del && remove.mutate(del.id)}
        onClose={() => setDel(null)}
      />
    </div>
  );
}
