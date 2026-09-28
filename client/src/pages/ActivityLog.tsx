import { Fragment, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { api, type Page } from '../lib/api';
import { fmtDate, fmtNumber, localDateToIso } from '../lib/format';
import { useT } from '../lib/i18n';
import type { AuditEntry } from '../lib/types';
import { Badge, Card, EmptyState, Field, Input, LoadingBlock, PageHeader, Pagination, Select, Table, Td, Th } from '../components/ui';

const ACTION_GROUPS = ['STOCK', 'PRODUCT', 'RECEIPT', 'DISPATCH', 'INVENTORY', 'IMPORT', 'CATEGORY', 'SUPPLIER', 'LOCATION', 'USER', 'AUTH', 'SETTINGS'];

function tone(action: string): 'ok' | 'bad' | 'warn' | 'brand' | 'neutral' {
  if (action.startsWith('STOCK.STOCK_IN') || action.startsWith('STOCK.RETURN_IN') || action.endsWith('CREATE')) return 'ok';
  if (action.startsWith('STOCK.STOCK_OUT') || action.endsWith('DELETE') || action.endsWith('FAILED') || action.endsWith('CANCEL')) return 'bad';
  if (action.startsWith('STOCK.ADJUST')) return 'warn';
  if (action.startsWith('AUTH')) return 'neutral';
  return 'brand';
}

function Json({ value }: { value: string | null }) {
  if (!value) return <span className="text-muted">—</span>;
  try {
    const obj = JSON.parse(value) as Record<string, unknown>;
    return (
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 font-mono text-xs">
        {Object.entries(obj).map(([k, v]) => (
          <Fragment key={k}>
            <dt className="text-muted">{k}</dt>
            <dd className="break-all">{v === null ? 'null' : typeof v === 'object' ? JSON.stringify(v) : String(v)}</dd>
          </Fragment>
        ))}
      </dl>
    );
  } catch {
    return <span className="font-mono text-xs">{value}</span>;
  }
}

export default function ActivityLog() {
  const t = useT();
  const [q, setQ] = useState('');
  const [userId, setUserId] = useState('');
  const [action, setAction] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<Set<number>>(new Set());

  const users = useQuery({
    queryKey: ['tx-users'],
    queryFn: () => api.get<{ data: { id: number; username: string; full_name: string }[] }>('/transactions/users').then((r) => r.data),
  });
  const filters = useMemo(
    () => ({ q, userId, action, from: from ? localDateToIso(from) : undefined, to: to ? localDateToIso(to, true) : undefined }),
    [q, userId, action, from, to],
  );
  const { data, isLoading } = useQuery({
    queryKey: ['audit', filters, page],
    queryFn: () => api.get<Page<AuditEntry>>('/audit', { ...filters, page, pageSize: 50 }),
    placeholderData: keepPreviousData,
  });

  const toggle = (id: number) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const time = (iso: string) => new Date(iso).toLocaleTimeString('el-GR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  return (
    <div>
      <PageHeader title={t('Activity Log')} subtitle={t('Who did what, when and from where')} />
      <Card>
        <div className="flex flex-wrap items-end gap-2 border-b border-line p-3">
          <Field label={t('Search')} className="w-full sm:w-64">
            <Input placeholder={t('Description, user…')} value={q} onChange={(e) => (setQ(e.target.value), setPage(1))} />
          </Field>
          <Field label={t('User')}>
            <Select value={userId} onChange={(e) => (setUserId(e.target.value), setPage(1))}>
              <option value="">{t('All users')}</option>
              {users.data?.map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
            </Select>
          </Field>
          <Field label={t('Action')}>
            <Select value={action} onChange={(e) => (setAction(e.target.value), setPage(1))}>
              <option value="">{t('All actions')}</option>
              {ACTION_GROUPS.map((a) => <option key={a} value={a}>{a}</option>)}
            </Select>
          </Field>
          <Field label={t('From')}><Input type="date" value={from} onChange={(e) => (setFrom(e.target.value), setPage(1))} /></Field>
          <Field label={t('To')}><Input type="date" value={to} onChange={(e) => (setTo(e.target.value), setPage(1))} /></Field>
        </div>
        {isLoading ? (
          <LoadingBlock />
        ) : !data?.data.length ? (
          <EmptyState title={t('No activity found')} />
        ) : (
          <>
            <div className="px-4 pt-3 text-xs text-muted">{t('{n} entries', { n: fmtNumber(data.total) })}</div>
            <Table>
              <thead>
                <tr>
                  <Th className="w-6" />
                  <Th>{t('Date')}</Th>
                  <Th>{t('Time')}</Th>
                  <Th>{t('User')}</Th>
                  <Th>{t('Action')}</Th>
                  <Th>{t('Description')}</Th>
                  <Th className="hidden lg:table-cell">{t('Product')}</Th>
                  <Th className="hidden md:table-cell">IP</Th>
                </tr>
              </thead>
              <tbody>
                {data.data.map((a) => (
                  <Fragment key={a.id}>
                    <tr className="cursor-pointer hover:bg-surface-2" onClick={() => toggle(a.id)}>
                      <Td className="text-muted">{open.has(a.id) ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}</Td>
                      <Td className="tabular text-xs whitespace-nowrap">{fmtDate(a.created_at)}</Td>
                      <Td className="tabular text-xs whitespace-nowrap">{time(a.created_at)}</Td>
                      <Td className="whitespace-nowrap">{a.username ?? 'system'}</Td>
                      <Td><Badge tone={tone(a.action)} className="normal-case">{a.action}</Badge></Td>
                      <Td className="max-w-[520px] text-sm">{a.description}</Td>
                      <Td className="hidden lg:table-cell">
                        {a.product_id ? <Link to={`/products/${a.product_id}`} onClick={(e) => e.stopPropagation()} className="font-mono text-xs hover:underline">{a.product_sku}</Link> : '—'}
                      </Td>
                      <Td className="hidden font-mono text-xs text-muted md:table-cell">{a.ip_address ?? '—'}</Td>
                    </tr>
                    {open.has(a.id) && (
                      <tr className="bg-surface-2">
                        <Td />
                        <Td colSpan={7}>
                          <div className="grid gap-4 py-1 md:grid-cols-3">
                            <div>
                              <div className="mb-1 text-[11px] font-semibold text-muted uppercase">{t('Previous value')}</div>
                              <Json value={a.old_value} />
                            </div>
                            <div>
                              <div className="mb-1 text-[11px] font-semibold text-muted uppercase">{t('New value')}</div>
                              <Json value={a.new_value} />
                            </div>
                            <div className="text-xs text-muted">
                              <div className="mb-1 text-[11px] font-semibold uppercase">{t('Details')}</div>
                              <div>{a.entity_type ? `${a.entity_type} #${a.entity_id ?? ''}` : '—'}</div>
                              <div className="mt-1 break-all">{a.user_agent}</div>
                            </div>
                          </div>
                        </Td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </Table>
            <Pagination page={page} pageSize={50} total={data.total} onPage={setPage} />
          </>
        )}
      </Card>
    </div>
  );
}
