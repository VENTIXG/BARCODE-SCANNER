import { useMemo, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, X } from 'lucide-react';
import { toast } from 'sonner';
import { api, download, type Page } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtNumber, localDateToIso, todayLocal } from '../lib/format';
import { useT } from '../lib/i18n';
import { errMsg } from '../lib/queries';
import { TX_TYPES, type Transaction } from '../lib/types';
import { TxTable } from '../components/TxTable';
import { Button, Card, ConfirmDialog, EmptyState, Field, Input, LoadingBlock, PageHeader, Pagination, Select, TX_LABEL } from '../components/ui';

export default function Transactions() {
  const t = useT();
  const { can } = useAuth();
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [type, setType] = useState('');
  const [userId, setUserId] = useState('');
  const [from, setFrom] = useState(todayLocal(-30));
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const [reverse, setReverse] = useState<Transaction | null>(null);
  const [reason, setReason] = useState('');

  const users = useQuery({
    queryKey: ['tx-users'],
    queryFn: () => api.get<{ data: { id: number; username: string; full_name: string }[] }>('/transactions/users').then((r) => r.data),
  });

  const filters = useMemo(
    () => ({ q, type, userId, from: from ? localDateToIso(from) : undefined, to: to ? localDateToIso(to, true) : undefined }),
    [q, type, userId, from, to],
  );
  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['transactions', filters, page],
    queryFn: () => api.get<Page<Transaction>>('/transactions', { ...filters, page, pageSize: 50 }),
    placeholderData: keepPreviousData,
  });

  const rev = useMutation({
    mutationFn: () => api.post(`/transactions/${reverse!.id}/reverse`, { reason: reason || null }),
    onSuccess: () => {
      toast.success(t('Transaction reversed'));
      setReverse(null);
      setReason('');
      void qc.invalidateQueries();
    },
    onError: (e) => toast.error(errMsg(e)),
  });

  const presets: [string, () => void][] = [
    [t('Today'), () => (setFrom(todayLocal()), setTo(''))],
    [t('7 days'), () => (setFrom(todayLocal(-6)), setTo(''))],
    [t('30 days'), () => (setFrom(todayLocal(-29)), setTo(''))],
    [t('All'), () => (setFrom(''), setTo(''))],
  ];

  return (
    <div>
      <PageHeader
        title={t('Transactions')}
        subtitle={t('Complete, immutable history of every stock movement')}
        actions={
          can('export.run') && (
            <Button icon={<Download className="size-4" />} onClick={() => download('/export/transactions', filters).catch((e) => toast.error(errMsg(e)))}>
              {t('Export')}
            </Button>
          )
        }
      />
      <Card>
        <div className="flex flex-wrap items-end gap-2 border-b border-line p-3">
          <Field label={t('Search')} className="w-full sm:w-56">
            <Input placeholder={t('SKU, product, reference…')} value={q} onChange={(e) => (setQ(e.target.value), setPage(1))} />
          </Field>
          <Field label={t('Type')}>
            <Select value={type} onChange={(e) => (setType(e.target.value), setPage(1))}>
              <option value="">{t('All types')}</option>
              {TX_TYPES.map((ty) => <option key={ty} value={ty}>{t(TX_LABEL[ty])}</option>)}
            </Select>
          </Field>
          <Field label={t('User')}>
            <Select value={userId} onChange={(e) => (setUserId(e.target.value), setPage(1))}>
              <option value="">{t('All users')}</option>
              {users.data?.map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
            </Select>
          </Field>
          <Field label={t('From')}>
            <Input type="date" value={from} onChange={(e) => (setFrom(e.target.value), setPage(1))} />
          </Field>
          <Field label={t('To')}>
            <Input type="date" value={to} onChange={(e) => (setTo(e.target.value), setPage(1))} />
          </Field>
          <div className="flex gap-1 pb-0.5">
            {presets.map(([label, fn]) => (
              <Button key={label} size="sm" variant="ghost" onClick={() => (fn(), setPage(1))}>
                {label}
              </Button>
            ))}
            {(q || type || userId) && (
              <Button size="sm" variant="ghost" icon={<X className="size-3.5" />} onClick={() => (setQ(''), setType(''), setUserId(''))}>
                {t('Clear')}
              </Button>
            )}
          </div>
        </div>
        {isLoading ? (
          <LoadingBlock />
        ) : !data?.data.length ? (
          <EmptyState title={t('No transactions found')} />
        ) : (
          <div className={isFetching ? 'opacity-70' : ''}>
            <div className="px-4 pt-3 text-xs text-muted">{t('{n} transactions', { n: fmtNumber(data.total) })}</div>
            <TxTable rows={data.data} onReverse={can('transactions.reverse') ? setReverse : undefined} />
            <Pagination page={page} pageSize={50} total={data.total} onPage={setPage} />
          </div>
        )}
      </Card>
      <ConfirmDialog
        open={Boolean(reverse)}
        title={t('Reverse transaction #{id}?', { id: reverse?.id })}
        message={t('An opposite adjustment will be posted. The original transaction stays in the history.')}
        confirmLabel={t('Reverse')}
        tone="danger"
        loading={rev.isPending}
        onConfirm={() => rev.mutate()}
        onClose={() => setReverse(null)}
      >
        <Field label={t('Reason')} className="mt-3">
          <Input value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </ConfirmDialog>
    </div>
  );
}
