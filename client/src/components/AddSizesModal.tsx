import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, newIdempotencyKey } from '../lib/api';
import { useT } from '../lib/i18n';
import { errMsg } from '../lib/queries';
import type { Product } from '../lib/types';
import { Button, ErrorBox, Field, IconButton, Input, Modal } from './ui';
import { Trash2 } from 'lucide-react';

interface Row {
  size: string;
  sku: string;
  barcode: string;
  initialQuantity: string;
}

/**
 * Adds sizes (S, M, L, …) to a product. Each size gets its own SKU and barcode,
 * so it can be scanned, counted and tracked on its own.
 */
export function AddSizesModal({ product, open, onClose }: { product: Product; open: boolean; onClose: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const [sizesText, setSizesText] = useState('S, M, L');
  const [rows, setRows] = useState<Row[]>([]);
  const [idemKey, setIdemKey] = useState(newIdempotencyKey);

  useEffect(() => {
    if (open) {
      setSizesText('S, M, L');
      setIdemKey(newIdempotencyKey());
    }
  }, [open]);

  // Build one row per size, keeping what the user already typed for the same size.
  const parsed = useMemo(
    () => [...new Set(sizesText.split(/[,;\n]/).map((s) => s.trim()).filter(Boolean))],
    [sizesText],
  );
  useEffect(() => {
    setRows((prev) =>
      parsed.map((size) => {
        const old = prev.find((r) => r.size === size);
        return old ?? { size, sku: `${product.sku}-${size}`.replace(/\s+/g, '-').toUpperCase(), barcode: '', initialQuantity: '0' };
      }),
    );
  }, [parsed, product.sku]);

  const update = (i: number, patch: Partial<Row>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const valid = rows.length > 0 && rows.every((r) => r.size.trim() && r.sku.trim() && !/\s/.test(r.sku.trim()) && Number(r.initialQuantity) >= 0);

  const save = useMutation({
    mutationFn: () =>
      api.post<{ data: Product[] }>(
        `/products/${product.id}/variants`,
        {
          idempotencyKey: idemKey,
          variants: rows.map((r) => ({
            size: r.size.trim(),
            sku: r.sku.trim(),
            barcode: r.barcode.trim() || null,
            initialQuantity: Number(r.initialQuantity) || 0,
          })),
        },
        { retries: 2 },
      ),
    onSuccess: (r) => {
      toast.success(t('Sizes added: {n}', { n: r.data.length }));
      setIdemKey(newIdempotencyKey());
      void qc.invalidateQueries();
      onClose();
    },
    onError: (e) => toast.error(errMsg(e)),
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('Add sizes to {name}', { name: product.name })}
      footer={
        <>
          <Button onClick={onClose}>{t('Cancel')}</Button>
          <Button variant="primary" disabled={!valid} loading={save.isPending} onClick={() => save.mutate()}>
            {t('Create sizes')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label={t('Sizes')} hint={t('Separate with commas, e.g. S, M, L, XL')}>
          <Input value={sizesText} onChange={(e) => setSizesText(e.target.value)} />
        </Field>
        <div className="space-y-2">
          {rows.map((r, i) => (
            <div key={r.size + i} className="grid grid-cols-[64px_minmax(0,1fr)_minmax(0,1fr)_84px_auto] items-end gap-2">
              <div className="pb-2 text-center text-lg font-semibold">{r.size}</div>
              <Field label={i === 0 ? t('SKU') : ''}>
                <Input value={r.sku} onChange={(e) => update(i, { sku: e.target.value })} className="font-mono text-xs" />
              </Field>
              <Field label={i === 0 ? t('Barcode') : ''}>
                <Input value={r.barcode} onChange={(e) => update(i, { barcode: e.target.value })} className="font-mono text-xs" placeholder="EAN" />
              </Field>
              <Field label={i === 0 ? t('Opening stock') : ''}>
                <Input value={r.initialQuantity} inputMode="decimal" onChange={(e) => update(i, { initialQuantity: e.target.value })} className="tabular" />
              </Field>
              <IconButton label={t('Remove size')} onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))} className="mb-0.5">
                <Trash2 className="size-4" />
              </IconButton>
            </div>
          ))}
        </div>
        <ErrorBox error={rows.some((r) => /\s/.test(r.sku)) ? t('No spaces allowed') : null} />
      </div>
    </Modal>
  );
}
