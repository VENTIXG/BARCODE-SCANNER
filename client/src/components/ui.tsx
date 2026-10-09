import {
  forwardRef,
  useEffect,
  useLayoutEffect,
  useRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { createPortal } from 'react-dom';
import clsx from 'clsx';
import { AlertTriangle, ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Loader2, PackageX, X } from 'lucide-react';
import { useT } from '../lib/i18n';
import { fmtNumber } from '../lib/format';
import type { StockStatus, TxType } from '../lib/types';

// ---- Buttons -----------------------------------------------------------------

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success';
type Size = 'sm' | 'md' | 'lg';

const variants: Record<Variant, string> = {
  primary: 'bg-brand text-white hover:bg-brand-hover shadow-sm',
  secondary: 'bg-surface text-fg border border-line-strong hover:bg-surface-3 shadow-sm',
  ghost: 'text-fg-2 hover:bg-surface-3 hover:text-fg',
  danger: 'bg-red-600 text-white hover:bg-red-700 shadow-sm',
  success: 'bg-emerald-600 text-white hover:bg-emerald-700 shadow-sm',
};
const sizes: Record<Size, string> = {
  sm: 'h-8 px-2.5 text-xs gap-1.5',
  md: 'h-9 px-3.5 text-sm gap-2',
  lg: 'h-11 px-5 text-base gap-2',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', loading, icon, className, children, disabled, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      className={clsx(
        'inline-flex shrink-0 items-center justify-center rounded-lg font-medium whitespace-nowrap transition-colors',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:cursor-not-allowed disabled:opacity-50',
        variants[variant],
        sizes[size],
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 className="size-4 animate-spin" /> : icon}
      {children}
    </button>
  );
});

export function IconButton({
  label,
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={clsx(
        'inline-flex size-8 items-center justify-center rounded-lg text-fg-2 transition-colors hover:bg-surface-3 hover:text-fg disabled:opacity-40',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

// ---- Form controls -------------------------------------------------------------

/** Controls are full width unless the caller sets a width class. */
const width = (className?: string) => (className && /(^|\s)(w-|flex-1)/.test(className) ? '' : 'w-full');
const control =
  'rounded-lg border border-line-strong bg-surface px-3 text-sm text-fg placeholder:text-muted shadow-xs transition-colors focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20 disabled:bg-surface-3 disabled:text-muted';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }>(
  function Input({ className, invalid, ...rest }, ref) {
    return <input ref={ref} className={clsx(control, width(className), 'h-9', invalid && 'border-bad focus:border-bad focus:ring-bad/20', className)} {...rest} />;
  },
);

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select(
  { className, children, ...rest },
  ref,
) {
  return (
    <select ref={ref} className={clsx(control, width(className), 'h-9 pr-8', className)} {...rest}>
      {children}
    </select>
  );
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea(
  { className, ...rest },
  ref,
) {
  return <textarea ref={ref} className={clsx(control, 'w-full min-h-[72px] py-2', className)} {...rest} />;
});

export function Field({
  label,
  hint,
  error,
  required,
  children,
  className,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={clsx('block', className)}>
      <span className="mb-1.5 block text-xs font-medium text-fg-2">
        {label}
        {required && <span className="ml-0.5 text-bad">*</span>}
      </span>
      {children}
      {error ? (
        <span className="mt-1 block text-xs text-bad">{error}</span>
      ) : hint ? (
        <span className="mt-1 block text-xs text-muted">{hint}</span>
      ) : null}
    </label>
  );
}

export function Checkbox({
  checked,
  onChange,
  label,
  description,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: ReactNode;
  description?: ReactNode;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5 text-sm">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 size-4 rounded border-line-strong accent-[var(--brand)]"
      />
      <span>
        <span className="text-fg">{label}</span>
        {description && <span className="block text-xs text-muted">{description}</span>}
      </span>
    </label>
  );
}

/** Segmented control (radio group styled as buttons). */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  size = 'md',
  className,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: ReactNode; activeClass?: string }[];
  size?: 'md' | 'lg';
  className?: string;
}) {
  return (
    <div className={clsx('inline-flex rounded-lg border border-line bg-surface-3 p-0.5', className)} role="radiogroup">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={clsx(
            'inline-flex flex-1 items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap transition-colors',
            size === 'lg' ? 'h-11 px-2 text-sm sm:px-4 sm:text-base' : 'h-8 px-2.5 text-sm sm:px-3',
            value === o.value ? (o.activeClass ?? 'bg-surface text-fg shadow-sm') : 'text-fg-2 hover:text-fg',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ---- Layout pieces ----------------------------------------------------------------

export function Card({ className, children, ...rest }: { className?: string; children: ReactNode } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={clsx('rounded-xl border border-line bg-surface shadow-xs', className)} {...rest}>
      {children}
    </div>
  );
}

export function CardHeader({ title, subtitle, actions, className }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <div className={clsx('flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3', className)}>
      <div className="min-w-0">
        <h3 className="text-sm font-semibold text-fg">{title}</h3>
        {subtitle && <p className="text-xs text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

export function PageHeader({ title, subtitle, actions, back }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; back?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        {back}
        <h1 className="text-xl font-semibold tracking-tight text-fg sm:text-2xl">{title}</h1>
        {subtitle && <p className="mt-0.5 text-sm text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={clsx('size-5 animate-spin text-muted', className)} />;
}

export function LoadingBlock() {
  return (
    <div className="flex items-center justify-center py-16">
      <Spinner />
    </div>
  );
}

export function EmptyState({ icon, title, description, action }: { icon?: ReactNode; title: ReactNode; description?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      <div className="mb-3 flex size-11 items-center justify-center rounded-full bg-surface-3 text-muted">
        {icon ?? <PackageX className="size-5" />}
      </div>
      <p className="text-sm font-medium text-fg">{title}</p>
      {description && <p className="mt-1 max-w-sm text-sm text-muted">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <div className="flex items-start gap-2 rounded-lg border border-bad/30 bg-bad-soft px-3 py-2.5 text-sm text-bad">
      <AlertTriangle className="mt-0.5 size-4 shrink-0" />
      <span>{error instanceof Error ? error.message : String(error)}</span>
    </div>
  );
}

// ---- Badges -------------------------------------------------------------------------

type Tone = 'neutral' | 'brand' | 'ok' | 'warn' | 'bad';
const tones: Record<Tone, string> = {
  neutral: 'bg-surface-3 text-fg-2',
  brand: 'bg-brand-soft text-brand-fg',
  ok: 'bg-ok-soft text-ok',
  warn: 'bg-warn-soft text-warn',
  bad: 'bg-bad-soft text-bad',
};

export function Badge({ tone = 'neutral', children, className, icon }: { tone?: Tone; children: ReactNode; className?: string; icon?: ReactNode }) {
  return (
    <span className={clsx('inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-semibold whitespace-nowrap uppercase tracking-wide', tones[tone], className)}>
      {icon}
      {children}
    </span>
  );
}

export function StockBadge({ status, className }: { status: StockStatus; className?: string }) {
  const t = useT();
  if (status === 'OUT_OF_STOCK')
    return <Badge tone="bad" className={className} icon={<span className="size-1.5 rounded-full bg-current" />}>{t('Out of stock')}</Badge>;
  if (status === 'LOW_STOCK')
    return <Badge tone="warn" className={className} icon={<AlertTriangle className="size-3" />}>{t('Low stock')}</Badge>;
  return <Badge tone="ok" className={className}>{t('In stock')}</Badge>;
}

export function StatusBadge({ status }: { status: 'ACTIVE' | 'INACTIVE' }) {
  const t = useT();
  return status === 'ACTIVE' ? <Badge tone="brand">{t('Active')}</Badge> : <Badge>{t('Inactive')}</Badge>;
}

export const TX_TONE: Record<TxType, Tone> = {
  STOCK_IN: 'ok',
  STOCK_OUT: 'bad',
  ADJUSTMENT_PLUS: 'brand',
  ADJUSTMENT_MINUS: 'warn',
  RETURN_IN: 'ok',
  RETURN_OUT: 'warn',
  INITIAL_STOCK: 'neutral',
};

export const TX_LABEL: Record<TxType, string> = {
  STOCK_IN: 'Stock in',
  STOCK_OUT: 'Stock out',
  ADJUSTMENT_PLUS: 'Adjustment +',
  ADJUSTMENT_MINUS: 'Adjustment −',
  RETURN_IN: 'Return in',
  RETURN_OUT: 'Return out',
  INITIAL_STOCK: 'Initial stock',
};

export function TxTypeBadge({ type }: { type: TxType }) {
  const t = useT();
  return <Badge tone={TX_TONE[type]}>{t(TX_LABEL[type])}</Badge>;
}

export function QtyChange({ value, unit }: { value: number; unit?: string }) {
  return (
    <span className={clsx('tabular font-semibold', value > 0 ? 'text-ok' : 'text-bad')}>
      {value > 0 ? '+' : '−'}
      {fmtNumber(Math.abs(value), Number.isInteger(value) ? 0 : 3)}
      {unit && unit !== 'pcs' ? ` ${unit}` : ''}
    </span>
  );
}

// ---- Table ----------------------------------------------------------------------------

export function Table({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={clsx('overflow-x-auto', className)}>
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  );
}

export function Th({
  children,
  className,
  sort,
  current,
  dir,
  onSort,
  align = 'left',
}: {
  children?: ReactNode;
  className?: string;
  sort?: string;
  current?: string;
  dir?: 'asc' | 'desc';
  onSort?: (s: string) => void;
  align?: 'left' | 'right' | 'center';
}) {
  const active = sort && current === sort;
  return (
    <th
      className={clsx(
        'sticky top-0 z-[1] border-b border-line bg-surface-2 px-3 py-2.5 text-[11px] font-semibold tracking-wide whitespace-nowrap text-muted uppercase',
        align === 'right' ? 'text-right' : align === 'center' ? 'text-center' : 'text-left',
        className,
      )}
    >
      {sort && onSort ? (
        <button type="button" onClick={() => onSort(sort)} className={clsx('inline-flex items-center gap-1 uppercase hover:text-fg', active && 'text-fg')}>
          {children}
          {active && (dir === 'desc' ? <ArrowDown className="size-3" /> : <ArrowUp className="size-3" />)}
        </button>
      ) : (
        children
      )}
    </th>
  );
}

export function Td({ children, className, align = 'left', ...rest }: { children?: ReactNode; className?: string; align?: 'left' | 'right' | 'center' } & React.TdHTMLAttributes<HTMLTableCellElement>) {
  return (
    <td className={clsx('border-b border-line px-3 py-2.5 align-middle', align === 'right' && 'text-right', align === 'center' && 'text-center', className)} {...rest}>
      {children}
    </td>
  );
}

export function Pagination({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const t = useT();
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm text-muted">
      <span className="tabular">{t('{from}–{to} of {total}', { from: fmtNumber(from), to: fmtNumber(to), total: fmtNumber(total) })}</span>
      <div className="flex items-center gap-1">
        <IconButton label={t('Previous page')} disabled={page <= 1} onClick={() => onPage(page - 1)}>
          <ChevronLeft className="size-4" />
        </IconButton>
        <span className="tabular px-2 text-fg-2">
          {page} / {pages}
        </span>
        <IconButton label={t('Next page')} disabled={page >= pages} onClick={() => onPage(page + 1)}>
          <ChevronRight className="size-4" />
        </IconButton>
      </div>
    </div>
  );
}

// ---- Modal ------------------------------------------------------------------------------

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  size = 'md',
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
}) {
  const t = useT();
  const panel = useRef<HTMLDivElement>(null);
  // Callers usually pass a new onClose function on every render. Keeping it in a ref means
  // the effect below runs only when the dialog opens or closes, not on every keystroke
  // (it used to move the cursor back to the first field after each letter).
  const onCloseRef = useRef(onClose);
  useLayoutEffect(() => {
    onCloseRef.current = onClose;
  });
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Only the top-most dialog closes.
      const dialogs = document.querySelectorAll('[role=dialog]');
      if (dialogs[dialogs.length - 1] === panel.current) onCloseRef.current();
    };
    window.addEventListener('keydown', onKey);
    const prev = document.activeElement as HTMLElement | null;
    // Focus the first field, unless a field inside the dialog already has the focus (autoFocus).
    const timer = setTimeout(() => {
      if (!panel.current || panel.current.contains(document.activeElement)) return;
      const first =
        panel.current.querySelector<HTMLElement>('[data-autofocus]') ??
        panel.current.querySelector<HTMLElement>('input:not([type=hidden]):not([disabled]), select:not([disabled]), textarea:not([disabled])');
      first?.focus();
    }, 20);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('keydown', onKey);
      prev?.focus?.();
    };
  }, [open]);
  if (!open) return null;
  const widths = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-2xl', xl: 'max-w-4xl' };
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={panel} role="dialog" aria-modal="true" className={clsx('flex max-h-[92vh] w-full flex-col rounded-t-2xl border border-line bg-surface shadow-2xl sm:rounded-2xl', widths[size])}>
        <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
          <h2 className="text-base font-semibold text-fg">{title}</h2>
          <IconButton label={t('Close')} onClick={onClose}>
            <X className="size-4" />
          </IconButton>
        </div>
        <div className="overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  tone = 'primary',
  loading,
  onConfirm,
  onClose,
  children,
}: {
  open: boolean;
  title: ReactNode;
  message?: ReactNode;
  confirmLabel?: ReactNode;
  tone?: 'primary' | 'danger' | 'success';
  loading?: boolean;
  onConfirm: () => void;
  onClose: () => void;
  children?: ReactNode;
}) {
  const t = useT();
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>{t('Cancel')}</Button>
          <Button variant={tone} loading={loading} onClick={onConfirm} data-autofocus>
            {confirmLabel ?? t('Confirm')}
          </Button>
        </>
      }
    >
      {message && <p className="text-sm text-fg-2">{message}</p>}
      {children}
    </Modal>
  );
}

// ---- Misc ---------------------------------------------------------------------------------

export function ProductThumb({ url, name, size = 'md' }: { url: string | null; name: string; size?: 'sm' | 'md' | 'lg' | 'xl' }) {
  const s = { sm: 'size-8', md: 'size-10', lg: 'size-16', xl: 'size-28' }[size];
  if (url) return <img src={url} alt={name} className={clsx(s, 'shrink-0 rounded-lg border border-line bg-white object-contain')} loading="lazy" />;
  const initials = name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase();
  return (
    <div className={clsx(s, 'flex shrink-0 items-center justify-center rounded-lg bg-surface-3 font-semibold text-muted', size === 'xl' ? 'text-2xl' : size === 'lg' ? 'text-base' : 'text-xs')}>
      {initials}
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-line-strong bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] text-fg-2">{children}</kbd>;
}

export function Tabs<T extends string>({ value, onChange, tabs }: { value: T; onChange: (v: T) => void; tabs: { value: T; label: ReactNode; count?: number }[] }) {
  return (
    <div className="mb-4 flex gap-1 overflow-x-auto border-b border-line">
      {tabs.map((tab) => (
        <button
          key={tab.value}
          type="button"
          onClick={() => onChange(tab.value)}
          className={clsx(
            '-mb-px flex items-center gap-2 border-b-2 px-3 py-2 text-sm font-medium whitespace-nowrap transition-colors',
            value === tab.value ? 'border-brand text-fg' : 'border-transparent text-muted hover:text-fg',
          )}
        >
          {tab.label}
          {tab.count != null && <span className="tabular rounded-full bg-surface-3 px-1.5 text-xs text-fg-2">{tab.count}</span>}
        </button>
      ))}
    </div>
  );
}
