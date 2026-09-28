import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Ban, Printer } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDate, fmtDateTime, fmtMoney, fmtQty } from '../lib/format';
import { useT } from '../lib/i18n';
import { errMsg } from '../lib/queries';
import type { StockDocument } from '../lib/types';
import { Badge, Button, Card, ConfirmDialog, EmptyState, Field, Input, LoadingBlock, Table, Td, Th } from '../components/ui';

export default function DocumentView({ kind }: { kind: 'receipt' | 'dispatch' }) {
  const t = useT();
  const { id } = useParams();
  const [params] = useSearchParams();
  const { can, settings } = useAuth();
  const qc = useQueryClient();
  const isIn = kind === 'receipt';
  const base = isIn ? '/stock-in' : '/stock-out';
  const [cancelOpen, setCancelOpen] = useState(false);
  const [reason, setReason] = useState('');

  const { data: doc, isLoading } = useQuery({
    queryKey: ['document', kind, id],
    queryFn: () => api.get<{ data: StockDocument }>(`/${isIn ? 'receipts' : 'dispatches'}/${id}`).then((r) => r.data),
  });

  useEffect(() => {
    if (doc && params.get('print')) setTimeout(() => window.print(), 300);
  }, [doc, params]);

  const cancel = useMutation({
    mutationFn: () => api.post(`/${isIn ? 'receipts' : 'dispatches'}/${id}/cancel`, { reason: reason || null }),
    onSuccess: () => {
      toast.success(t('Document cancelled and stock movements reversed'));
      setCancelOpen(false);
      void qc.invalidateQueries();
    },
    onError: (e) => toast.error(errMsg(e)),
  });

  if (isLoading) return <LoadingBlock />;
  if (!doc) return <EmptyState title={t('Document not found')} />;

  return (
    <div className="mx-auto max-w-5xl">
      <div className="no-print mb-4 flex flex-wrap items-center justify-between gap-2">
        <Link to={`${base}?tab=history`} className="inline-flex items-center gap-1 text-sm text-muted hover:text-fg">
          <ArrowLeft className="size-4" /> {isIn ? t('Receipt history') : t('Dispatch history')}
        </Link>
        <div className="flex gap-2">
          {doc.status === 'CONFIRMED' && can('transactions.reverse') && (
            <Button variant="ghost" icon={<Ban className="size-4" />} onClick={() => setCancelOpen(true)}>
              {t('Cancel document')}
            </Button>
          )}
          <Button icon={<Printer className="size-4" />} onClick={() => window.print()}>
            {t('Print')}
          </Button>
        </div>
      </div>

      <Card className="print-plain p-6">
        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-line pb-5">
          <div>
            <div className="text-xs font-semibold tracking-wider text-muted uppercase">{settings.companyName}</div>
            <h1 className="mt-1 text-2xl font-semibold">{isIn ? t('Goods receipt') : t('Dispatch note')}</h1>
            <div className="mt-1 font-mono text-lg">{doc.number}</div>
          </div>
          <div className="text-right">
            {doc.status === 'CANCELLED' ? <Badge tone="bad">{t('Cancelled')}</Badge> : <Badge tone="ok">{t('Confirmed')}</Badge>}
            <div className="mt-2 text-sm text-muted">{t('Date')}: <span className="text-fg">{fmtDate(doc.date)}</span></div>
            <div className="text-sm text-muted">{t('Confirmed')}: <span className="text-fg">{fmtDateTime(doc.confirmed_at)}</span></div>
          </div>
        </div>

        <dl className="grid grid-cols-2 gap-4 py-5 text-sm md:grid-cols-4">
          <div>
            <dt className="text-xs text-muted">{isIn ? t('Supplier') : t('Customer / recipient')}</dt>
            <dd className="font-medium">{(isIn ? doc.supplier_name : doc.customer_name) ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted">{isIn ? t('Invoice / delivery note no.') : t('Reference')}</dt>
            <dd className="font-medium">{(isIn ? doc.invoice_number : doc.reference) ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted">{t('User')}</dt>
            <dd className="font-medium">{doc.created_by_name ?? doc.created_by_username ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted">{t('Comments')}</dt>
            <dd className="whitespace-pre-line">{doc.notes ?? '—'}</dd>
          </div>
        </dl>

        <Table>
          <thead>
            <tr>
              <Th>#</Th>
              <Th>SKU</Th>
              <Th>{t('Barcode')}</Th>
              <Th>{t('Product')}</Th>
              <Th align="right">{t('Quantity')}</Th>
              <Th align="right">{isIn ? t('Unit cost') : t('Unit price')}</Th>
              <Th align="right">{t('Total')}</Th>
            </tr>
          </thead>
          <tbody>
            {doc.items?.map((it, i) => (
              <tr key={it.id}>
                <Td className="text-muted">{i + 1}</Td>
                <Td className="font-mono text-xs">{it.sku}</Td>
                <Td className="font-mono text-xs">{it.barcode ?? '—'}</Td>
                <Td>
                  <Link to={`/products/${it.product_id}`} className="hover:underline">{it.name}</Link>
                </Td>
                <Td align="right" className="tabular font-medium">{fmtQty(it.quantity, it.unit)}</Td>
                <Td align="right" className="tabular">{it.unit_price != null ? fmtMoney(it.unit_price) : '—'}</Td>
                <Td align="right" className="tabular">{it.unit_price != null ? fmtMoney(it.unit_price * it.quantity) : '—'}</Td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="font-semibold">
              <Td colSpan={4} align="right">{t('Total')}</Td>
              <Td align="right" className="tabular">{fmtQty(doc.total_quantity)}</Td>
              <Td />
              <Td align="right" className="tabular">{fmtMoney(doc.total_value)}</Td>
            </tr>
          </tfoot>
        </Table>

        <div className="mt-12 hidden grid-cols-2 gap-12 text-center text-xs text-muted print:grid">
          <div className="border-t border-line pt-2">{isIn ? t('Received by') : t('Dispatched by')}</div>
          <div className="border-t border-line pt-2">{isIn ? t('Delivered by') : t('Received by')}</div>
        </div>
      </Card>

      <ConfirmDialog
        open={cancelOpen}
        title={t('Cancel {number}?', { number: doc.number })}
        message={isIn ? t('All quantities of this receipt will be removed from stock again (reversal transactions).') : t('All quantities of this dispatch will be returned to stock (reversal transactions).')}
        confirmLabel={t('Cancel document')}
        tone="danger"
        loading={cancel.isPending}
        onConfirm={() => cancel.mutate()}
        onClose={() => setCancelOpen(false)}
      >
        <Field label={t('Reason')} className="mt-3">
          <Input value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </ConfirmDialog>
    </div>
  );
}
