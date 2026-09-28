import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { ScanBarcode } from 'lucide-react';
import { api, type Page } from '../lib/api';
import { fmtQty } from '../lib/format';
import { useT } from '../lib/i18n';
import type { Product } from '../lib/types';
import { ProductThumb, StockBadge } from './ui';

export interface ProductPickerHandle {
  focus: () => void;
}

/**
 * Combined barcode-scan + product search input.
 * - A scanner (or typing a code and pressing Enter) triggers an exact
 *   barcode/SKU lookup via `onCode`.
 * - Typing text shows matching products; arrows + Enter or click selects.
 */
export const ProductPicker = forwardRef<
  ProductPickerHandle,
  {
    onCode: (code: string) => void;
    onSelect: (product: Product) => void;
    placeholder?: string;
    size?: 'md' | 'lg';
    autoFocus?: boolean;
    /** Keep focus in the input (for continuous scanning). */
    sticky?: boolean;
    className?: string;
  }
>(function ProductPicker({ onCode, onSelect, placeholder, size = 'lg', autoFocus, sticky, className }, ref) {
  const t = useT();
  const input = useRef<HTMLInputElement>(null);
  const [text, setText] = useState('');
  const [debounced, setDebounced] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const lastKey = useRef(0);
  const typedFast = useRef(true);

  useImperativeHandle(ref, () => ({ focus: () => input.current?.focus() }), []);

  useEffect(() => {
    const id = setTimeout(() => setDebounced(text.trim()), 200);
    return () => clearTimeout(id);
  }, [text]);

  const { data } = useQuery({
    queryKey: ['picker', debounced],
    queryFn: () => api.get<Page<Product>>('/products', { q: debounced, pageSize: 8, status: 'ACTIVE' }).then((r) => r.data),
    enabled: debounced.length >= 2 && open,
    placeholderData: (p) => p,
  });
  const results = debounced.length >= 2 ? (data ?? []) : [];

  const reset = () => {
    setText('');
    setDebounced('');
    setOpen(false);
    setActive(-1);
    typedFast.current = true;
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const now = performance.now();
    if (e.key.length === 1) {
      if (text.length > 0 && now - lastKey.current > 60) typedFast.current = false;
      lastKey.current = now;
    }
    if (e.key === 'ArrowDown' && results.length) {
      e.preventDefault();
      setOpen(true);
      setActive((a) => Math.min(a + 1, results.length - 1));
    } else if (e.key === 'ArrowUp' && results.length) {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Escape') {
      reset();
    } else if (e.key === 'Enter' || (e.key === 'Tab' && typedFast.current && text.length >= 3)) {
      e.preventDefault();
      const value = text.trim();
      if (!value) return;
      if (active >= 0 && results[active] && open) {
        onSelect(results[active]);
      } else {
        onCode(value);
      }
      reset();
    }
  };

  const onBlur = () => {
    setTimeout(() => {
      setOpen(false);
      // Continuous scanning: return focus unless the user moved to another control.
      if (sticky) {
        const el = document.activeElement;
        if (!el || el === document.body) input.current?.focus();
      }
    }, 120);
  };

  const big = size === 'lg';
  return (
    <div className={clsx('relative', className)}>
      <ScanBarcode className={clsx('pointer-events-none absolute top-1/2 -translate-y-1/2 text-muted', big ? 'left-3.5 size-6' : 'left-3 size-4')} />
      <input
        ref={input}
        autoFocus={autoFocus}
        value={text}
        onChange={(e) => (setText(e.target.value), setOpen(true), setActive(-1))}
        onKeyDown={onKeyDown}
        onBlur={onBlur}
        placeholder={placeholder ?? t('Scan barcode or type SKU / product name…')}
        autoComplete="off"
        spellCheck={false}
        className={clsx(
          'w-full rounded-xl border-2 border-line-strong bg-surface font-mono text-fg placeholder:font-sans placeholder:text-muted focus:border-brand focus:ring-4 focus:ring-brand/15 focus:outline-none',
          big ? 'h-14 pr-4 pl-12 text-lg' : 'h-10 pr-3 pl-9 text-sm',
        )}
      />
      {open && results.length > 0 && (
        <div className="absolute top-full right-0 left-0 z-40 mt-1 max-h-96 overflow-y-auto rounded-xl border border-line bg-surface shadow-xl">
          {results.map((p, i) => (
            <button
              key={p.id}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(i)}
              onClick={() => (onSelect(p), reset(), input.current?.focus())}
              className={clsx('flex w-full items-center gap-3 px-3 py-2 text-left', i === active && 'bg-surface-3')}
            >
              <ProductThumb url={p.imageUrl} name={p.name} size="sm" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-fg">{p.name}</div>
                <div className="truncate font-mono text-xs text-muted">
                  {p.sku}
                  {p.barcode ? ` · ${p.barcode}` : ''}
                  {p.locationCode ? ` · ${p.locationCode}` : ''}
                </div>
              </div>
              <div className="text-right">
                <div className="tabular text-sm font-semibold">{fmtQty(p.quantity, p.unit)}</div>
                {p.stockStatus !== 'IN_STOCK' && <StockBadge status={p.stockStatus} />}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
});
