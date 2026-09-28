import { Link } from 'react-router-dom';
import { Undo2 } from 'lucide-react';
import { fmtDateTime, fmtQty } from '../lib/format';
import { useT } from '../lib/i18n';
import type { Transaction } from '../lib/types';
import { Badge, IconButton, QtyChange, Table, Td, Th, TxTypeBadge } from './ui';

const SOURCE_LABEL: Record<string, string> = {
  RECEIPT: 'Receipt',
  DISPATCH: 'Dispatch',
  SCAN: 'Scan',
  ADJUSTMENT: 'Adjustment',
  IMPORT: 'Import',
  PRODUCT: 'Product',
  REVERSAL: 'Reversal',
  MANUAL: 'Manual',
};

export function sourceLink(tx: Transaction): string | null {
  if (tx.source_type === 'RECEIPT' && tx.source_id) return `/stock-in/${tx.source_id}`;
  if (tx.source_type === 'DISPATCH' && tx.source_id) return `/stock-out/${tx.source_id}`;
  return null;
}

/** Chronological transaction ledger (audit trail) table. */
export function TxTable({ rows, showProduct = true, onReverse }: { rows: Transaction[]; showProduct?: boolean; onReverse?: (tx: Transaction) => void }) {
  const t = useT();
  return (
    <Table>
      <thead>
        <tr>
          <Th>{t('Date/Time')}</Th>
          <Th>{t('Type')}</Th>
          {showProduct && <Th>{t('Product')}</Th>}
          <Th align="right">{t('Previous')}</Th>
          <Th align="right">{t('Change')}</Th>
          <Th align="right">{t('New')}</Th>
          <Th>{t('User')}</Th>
          <Th>{t('Reference')}</Th>
          <Th className="hidden lg:table-cell">{t('Notes')}</Th>
          {onReverse && <Th />}
        </tr>
      </thead>
      <tbody>
        {rows.map((tx) => {
          const link = sourceLink(tx);
          return (
            <tr key={tx.id} className="hover:bg-surface-2">
              <Td className="tabular text-xs whitespace-nowrap">
                {fmtDateTime(tx.created_at)}
                <div className="text-[10px] text-muted">#{tx.id}</div>
              </Td>
              <Td>
                <div className="flex flex-col items-start gap-1">
                  <TxTypeBadge type={tx.type} />
                  <span className="text-[10px] text-muted">{t(SOURCE_LABEL[tx.source_type] ?? tx.source_type)}</span>
                </div>
              </Td>
              {showProduct && (
                <Td>
                  <Link to={`/products/${tx.product_id}`} className="block max-w-[240px] truncate font-medium hover:underline">
                    {tx.product_name}
                  </Link>
                  <div className="font-mono text-xs text-muted">{tx.sku}</div>
                </Td>
              )}
              <Td align="right" className="tabular text-fg-2">{fmtQty(tx.quantity_before)}</Td>
              <Td align="right"><QtyChange value={tx.quantity_change} /></Td>
              <Td align="right" className="tabular font-semibold">{fmtQty(tx.quantity_after)}</Td>
              <Td className="whitespace-nowrap">{tx.user_full_name ?? tx.username ?? 'system'}</Td>
              <Td className="max-w-[200px] truncate text-xs">
                {link ? <Link to={link} className="text-brand-fg hover:underline">{tx.reference}</Link> : (tx.reference ?? '—')}
              </Td>
              <Td className="hidden max-w-[260px] text-xs text-fg-2 lg:table-cell">
                <span className="line-clamp-2">{tx.notes ?? ''}</span>
                {tx.reversed_by_id && <Badge className="mt-1">{t('Reversed')}</Badge>}
              </Td>
              {onReverse && (
                <Td align="right">
                  {!tx.reversal_of_id && !tx.reversed_by_id && !link && (
                    <IconButton label={t('Reverse transaction')} onClick={() => onReverse(tx)}>
                      <Undo2 className="size-4" />
                    </IconButton>
                  )}
                </Td>
              )}
            </tr>
          );
        })}
      </tbody>
    </Table>
  );
}
