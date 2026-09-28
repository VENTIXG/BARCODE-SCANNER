import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { toast } from 'sonner';
import { api } from '../lib/api';
import { fmtQty, fmtSigned } from '../lib/format';
import { useT } from '../lib/i18n';
import { errMsg } from '../lib/queries';
import type { Product, Transaction } from '../lib/types';
import { Button, ErrorBox, Field, Input, Modal, ProductThumb, Segmented, Select } from './ui';

type Mode = 'count' | 'ADJUSTMENT_PLUS' | 'ADJUSTMENT_MINUS' | 'RETURN_IN' | 'RETURN_OUT';

const REASONS: Record<Mode, string[]> = {
  count: ['Physical inventory count', 'Cycle count correction'],
  ADJUSTMENT_PLUS: ['Found during count', 'Correction of wrong entry', 'Supplier bonus / free goods'],
  ADJUSTMENT_MINUS: ['Damaged goods', 'Expired goods', 'Lost / theft', 'Correction of wrong entry', 'Internal use / samples'],
  RETURN_IN: ['Customer return'],
  RETURN_OUT: ['Return to supplier'],
};

/** Inventory adjustment: physical count, manual +/- or returns. Always recorded as a transaction. */
export function AdjustStockModal({ product, open, onClose }: { product: Product; open: boolean; onClose: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const [mode, setMode] = useState<Mode>('count');
  const [qty, setQty] = useState('');
  const [reason, setReason] = useState(REASONS.count[0]);
  const [custom, setCustom] = useState('');
  const [reference, setReference] = useState('');

  useEffect(() => {
    if (open) {
      setMode('count');
      setQty('');
      setReason(REASONS.count[0]);
      setCustom('');
      setReference('');
    }
  }, [open]);
  useEffect(() => setReason(REASONS[mode][0]), [mode]);

  const n = qty === '' ? NaN : Number(qty.replace(',', '.'));
  const delta = Number.isNaN(n) ? 0 : mode === 'count' ? n - product.quantity : ['ADJUSTMENT_PLUS', 'RETURN_IN'].includes(mode) ? n : -n;
  const newQty = product.quantity + delta;
  const finalReason = reason === '__other' ? custom.trim() : t(reason);

  const m = useMutation({
    mutationFn: () =>
      api.post<{ data: { product: Product; transaction: Transaction | null } }>(
        '/stock/adjust',
        mode === 'count'
          ? { mode, productId: product.id, countedQuantity: n, reason: finalReason, reference: reference || null }
          : { mode, productId: product.id, quantity: n, reason: finalReason, reference: reference || null },
      ),
    onSuccess: (res) => {
      if (!res.data.transaction) toast.info(t('Counted quantity equals system quantity — no adjustment needed.'));
      else toast.success(t('Stock of {sku} updated to {qty}', { sku: product.sku, qty: fmtQty(res.data.product.quantity) }));
      void qc.invalidateQueries();
      onClose();
    },
  });

  const valid = !Number.isNaN(n) && n >= 0 && (mode === 'count' || n > 0) && finalReason.length > 0 && (mode === 'count' || newQty >= 0);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('Inventory adjustment')}
      footer={
        <>
          <Button onClick={onClose}>{t('Cancel')}</Button>
          <Button variant="primary" disabled={!valid} loading={m.isPending} onClick={() => m.mutate()}>
            {t('Save adjustment')}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) m.mutate();
        }}
        className="space-y-4"
      >
        <div className="flex items-center gap-3 rounded-lg bg-surface-2 p-3">
          <ProductThumb url={product.imageUrl} name={product.name} />
          <div className="min-w-0 flex-1">
            <div className="truncate font-medium">{product.name}</div>
            <div className="font-mono text-xs text-muted">{product.sku}</div>
          </div>
          <div className="text-right">
            <div className="text-[11px] text-muted uppercase">{t('System quantity')}</div>
            <div className="tabular text-xl font-semibold">{fmtQty(product.quantity, product.unit)}</div>
          </div>
        </div>

        <Segmented<Mode>
          value={mode}
          onChange={setMode}
          className="flex w-full flex-wrap"
          options={[
            { value: 'count', label: t('Physical count') },
            { value: 'ADJUSTMENT_PLUS', label: t('Add') },
            { value: 'ADJUSTMENT_MINUS', label: t('Remove') },
            { value: 'RETURN_IN', label: t('Return in') },
            { value: 'RETURN_OUT', label: t('Return out') },
          ]}
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={mode === 'count' ? t('Physical quantity (counted)') : t('Quantity')} required>
            <Input inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} className="tabular h-11 text-lg" autoFocus />
          </Field>
          <div className="rounded-lg border border-line p-3">
            <div className="flex justify-between text-sm">
              <span className="text-muted">{t('Adjustment')}</span>
              <span className={clsx('tabular font-semibold', delta > 0 ? 'text-ok' : delta < 0 ? 'text-bad' : 'text-fg')}>{fmtSigned(delta)}</span>
            </div>
            <div className="mt-1 flex justify-between text-sm">
              <span className="text-muted">{t('New quantity')}</span>
              <span className={clsx('tabular font-semibold', newQty < 0 && 'text-bad')}>{fmtQty(newQty)}</span>
            </div>
          </div>
        </div>
        {mode !== 'count' && newQty < 0 && <ErrorBox error={t('The quantity would become negative.')} />}

        <Field label={t('Reason')} required>
          <Select value={reason} onChange={(e) => setReason(e.target.value)}>
            {REASONS[mode].map((r) => <option key={r} value={r}>{t(r)}</option>)}
            <option value="__other">{t('Other…')}</option>
          </Select>
        </Field>
        {reason === '__other' && (
          <Field label={t('Describe the reason')} required>
            <Input value={custom} onChange={(e) => setCustom(e.target.value)} maxLength={500} />
          </Field>
        )}
        <Field label={t('Reference')} hint={t('Optional, e.g. count sheet or RMA number')}>
          <Input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={100} />
        </Field>
        <ErrorBox error={m.error ? errMsg(m.error) : null} />
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
