import { useEffect } from 'react';
import { fmtQty } from '../lib/format';
import { useT } from '../lib/i18n';
import type { Product } from '../lib/types';
import { Kbd, Modal, ProductThumb } from './ui';

/** Pick one of several products that share a barcode (keys 1–9 select). */
export function ProductChooser({ code, products, onPick, onClose }: { code: string; products: Product[] | null; onPick: (p: Product) => void; onClose: () => void }) {
  const t = useT();
  const open = Boolean(products?.length);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      const n = Number(e.key);
      if (n >= 1 && n <= products!.length) (e.preventDefault(), onPick(products![n - 1]));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, products, onPick]);
  return (
    <Modal open={open} onClose={onClose} title={t('Several products share barcode {code}', { code })}>
      <p className="mb-3 text-sm text-muted">{t('Choose the product you scanned (or press its number):')}</p>
      <div className="space-y-2">
        {products?.map((p, i) => (
          <button key={p.id} onClick={() => onPick(p)} className="flex w-full items-center gap-3 rounded-lg border border-line p-3 text-left hover:border-brand hover:bg-brand-soft">
            <Kbd>{i + 1}</Kbd>
            <ProductThumb url={p.imageUrl} name={p.name} size="sm" />
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium">{p.name}</div>
              <div className="font-mono text-xs text-muted">
                {p.sku} · {p.locationCode ?? '—'}
              </div>
            </div>
            <span className="tabular font-semibold">{fmtQty(p.quantity, p.unit)}</span>
          </button>
        ))}
      </div>
    </Modal>
  );
}
