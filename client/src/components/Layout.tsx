import { useCallback, useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLiveStatus, useRealtime } from '../lib/realtime';
import clsx from 'clsx';
import {
  AlertTriangle,
  ArrowDownToLine,
  ArrowLeftRight,
  ArrowUpFromLine,
  BarChart3,
  Boxes,
  FileSpreadsheet,
  History,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Menu,
  Moon,
  Package,
  ScanBarcode,
  Search,
  Settings,
  Sun,
  Tags,
  Truck,
  Users,
  Warehouse,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useI18n } from '../lib/i18n';
import { beep, useGlobalScan } from '../lib/scanner';
import { useTheme } from '../lib/theme';
import type { Product } from '../lib/types';
import { fmtQty } from '../lib/format';
import { Kbd, ProductThumb, StockBadge } from './ui';
import { useScanOverride } from './ScanContext';
import { ErrorBoundary } from './ErrorBoundary';

interface NavItem {
  to: string;
  label: string;
  icon: typeof Package;
  permission?: string;
  end?: boolean;
}

const NAV: { section?: string; items: NavItem[] }[] = [
  {
    items: [
      { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
      { to: '/products', label: 'Products', icon: Package, permission: 'products.view' },
      { to: '/scanner', label: 'Barcode Scanner', icon: ScanBarcode, permission: 'stock.scan' },
      { to: '/stock-in', label: 'Stock In', icon: ArrowDownToLine, permission: 'stock.in' },
      { to: '/stock-out', label: 'Stock Out', icon: ArrowUpFromLine, permission: 'stock.out' },
      { to: '/inventory', label: 'Inventory', icon: Boxes, permission: 'inventory.view' },
      { to: '/low-stock', label: 'Low Stock', icon: AlertTriangle, permission: 'products.view' },
      { to: '/transactions', label: 'Transactions', icon: ArrowLeftRight, permission: 'transactions.view' },
    ],
  },
  {
    section: 'Catalog',
    items: [
      { to: '/suppliers', label: 'Suppliers', icon: Truck, permission: 'catalog.view' },
      { to: '/categories', label: 'Categories', icon: Tags, permission: 'catalog.view' },
      { to: '/import-export', label: 'Import / Export', icon: FileSpreadsheet, permission: 'import.run' },
      { to: '/reports', label: 'Reports', icon: BarChart3, permission: 'reports.view' },
    ],
  },
  {
    section: 'Administration',
    items: [
      { to: '/activity', label: 'Activity Log', icon: History, permission: 'audit.view' },
      { to: '/users', label: 'Users', icon: Users, permission: 'users.manage' },
      { to: '/settings', label: 'Settings', icon: Settings },
    ],
  },
];

const ROLE_LABEL = { ADMIN: 'Administrator', MANAGER: 'Manager', WAREHOUSE_USER: 'Warehouse user' };

function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useI18n();
  const { can, settings } = useAuth();
  const low = useQuery({
    queryKey: ['low-stock-count'],
    queryFn: () => api.get<{ total: number }>('/products', { stock: 'alert', status: 'ACTIVE', pageSize: 1 }),
    refetchInterval: 60_000,
    enabled: can('products.view'),
  });
  return (
    <>
      <div className={clsx('fixed inset-0 z-30 bg-black/40 lg:hidden', open ? 'block' : 'hidden')} onClick={onClose} />
      <aside
        className={clsx(
          'no-print fixed inset-y-0 left-0 z-40 flex w-64 flex-col border-r border-line bg-surface transition-transform lg:translate-x-0',
          open ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <div className="flex h-14 items-center gap-2.5 border-b border-line px-4">
          <div className="flex size-8 items-center justify-center rounded-lg bg-brand text-white">
            <Warehouse className="size-4.5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold text-fg">Warehouse IMS</div>
            <div className="truncate text-[11px] text-muted">{settings.companyName}</div>
          </div>
          <button className="rounded-md p-1 text-muted hover:bg-surface-3 lg:hidden" onClick={onClose} aria-label={t('Close')}>
            <X className="size-4" />
          </button>
        </div>
        <nav className="flex-1 overflow-y-auto px-2.5 py-3">
          {NAV.map((group, gi) => {
            const items = group.items.filter((i) => !i.permission || can(i.permission));
            if (!items.length) return null;
            return (
              <div key={gi} className="mb-3">
                {group.section && <div className="px-2.5 pt-2 pb-1 text-[11px] font-semibold tracking-wider text-muted uppercase">{t(group.section)}</div>}
                {items.map((item) => (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    end={item.end}
                    onClick={onClose}
                    className={({ isActive }) =>
                      clsx(
                        'mb-0.5 flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors',
                        isActive ? 'bg-brand-soft text-brand-fg' : 'text-fg-2 hover:bg-surface-3 hover:text-fg',
                      )
                    }
                  >
                    <item.icon className="size-4 shrink-0" />
                    <span className="flex-1 truncate">{t(item.label)}</span>
                    {item.to === '/low-stock' && (low.data?.total ?? 0) > 0 && (
                      <span className="tabular rounded-full bg-warn-soft px-1.5 text-[11px] font-semibold text-warn">{low.data!.total}</span>
                    )}
                  </NavLink>
                ))}
              </div>
            );
          })}
        </nav>
      </aside>
    </>
  );
}

interface SearchResult {
  products: Product[];
  totalProducts: number;
  categories: { id: number; name: string }[];
  suppliers: { id: number; name: string }[];
}

function GlobalSearch() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const id = setTimeout(() => setDebounced(q.trim()), 150);
    return () => clearTimeout(id);
  }, [q]);

  // "/" focuses the search box
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement;
      if (e.key === '/' && el && !['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) {
        e.preventDefault();
        input.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const { data, isFetching } = useQuery({
    queryKey: ['search', debounced],
    queryFn: () => api.get<{ data: SearchResult }>('/search', { q: debounced }).then((r) => r.data),
    enabled: debounced.length > 0,
    placeholderData: (prev) => prev,
  });

  const products = debounced ? (data?.products ?? []) : [];
  const go = (path: string) => {
    setOpen(false);
    setQ('');
    input.current?.blur();
    navigate(path);
  };

  const onKeyDown = async (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') (e.preventDefault(), setActive((a) => Math.min(a + 1, products.length - 1)));
    else if (e.key === 'ArrowUp') (e.preventDefault(), setActive((a) => Math.max(a - 1, 0)));
    else if (e.key === 'Escape') (setOpen(false), input.current?.blur());
    else if (e.key === 'Enter') {
      e.preventDefault();
      const term = q.trim();
      if (!term) return;
      // Exact barcode/SKU (e.g. scanned into the search box) opens the product directly.
      const exact = await api.get<{ data: Product[] }>('/products/lookup', { code: term }).catch(() => ({ data: [] as Product[] }));
      if (exact.data.length === 1) return go(`/products/${exact.data[0].id}`);
      if (products[active] && debounced === term) return go(`/products/${products[active].id}`);
      go(`/products?q=${encodeURIComponent(term)}`);
    }
  };

  return (
    <div className="relative w-full max-w-xl">
      <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" />
      <input
        ref={input}
        value={q}
        onChange={(e) => (setQ(e.target.value), setOpen(true), setActive(0))}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={onKeyDown}
        placeholder={t('Search barcode, SKU, product, supplier, category…')}
        className="h-9 w-full rounded-lg border border-line bg-surface-2 pr-10 pl-9 text-sm text-fg placeholder:text-muted focus:border-brand focus:bg-surface focus:ring-2 focus:ring-brand/20 focus:outline-none"
        aria-label={t('Global search')}
      />
      <span className="pointer-events-none absolute top-1/2 right-2.5 hidden -translate-y-1/2 sm:block">
        <Kbd>/</Kbd>
      </span>
      {open && debounced && (
        <div className="absolute top-11 right-0 left-0 z-50 overflow-hidden rounded-xl border border-line bg-surface shadow-xl">
          {products.length === 0 && !isFetching && <div className="px-4 py-6 text-center text-sm text-muted">{t('No results for "{q}"', { q: debounced })}</div>}
          {products.map((p, i) => (
            <button
              key={p.id}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => go(`/products/${p.id}`)}
              onMouseEnter={() => setActive(i)}
              className={clsx('flex w-full items-center gap-3 px-3 py-2 text-left', i === active ? 'bg-surface-3' : '')}
            >
              <ProductThumb url={p.imageUrl} name={p.name} size="sm" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-fg">{p.name}</div>
                <div className="truncate font-mono text-xs text-muted">
                  {p.sku} {p.barcode && `· ${p.barcode}`} {p.locationCode && `· ${p.locationCode}`}
                </div>
              </div>
              <div className="text-right">
                <div className="tabular text-sm font-semibold text-fg">{fmtQty(p.quantity)}</div>
                {p.stockStatus !== 'IN_STOCK' && <StockBadge status={p.stockStatus} />}
              </div>
            </button>
          ))}
          {(data?.categories.length || data?.suppliers.length) ? (
            <div className="flex flex-wrap gap-1.5 border-t border-line px-3 py-2">
              {data?.categories.map((c) => (
                <button key={`c${c.id}`} onMouseDown={(e) => e.preventDefault()} onClick={() => go(`/products?categoryId=${c.id}`)} className="rounded-md bg-surface-3 px-2 py-1 text-xs text-fg-2 hover:text-fg">
                  {t('Category')}: {c.name}
                </button>
              ))}
              {data?.suppliers.map((s) => (
                <button key={`s${s.id}`} onMouseDown={(e) => e.preventDefault()} onClick={() => go(`/products?supplierId=${s.id}`)} className="rounded-md bg-surface-3 px-2 py-1 text-xs text-fg-2 hover:text-fg">
                  {t('Supplier')}: {s.name}
                </button>
              ))}
            </div>
          ) : null}
          {(data?.totalProducts ?? 0) > products.length && (
            <button onMouseDown={(e) => e.preventDefault()} onClick={() => go(`/products?q=${encodeURIComponent(debounced)}`)} className="w-full border-t border-line px-3 py-2 text-left text-xs font-medium text-brand-fg hover:bg-surface-3">
              {t('Show all {n} results', { n: data!.totalProducts })} →
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function UserMenu() {
  const { t, lang, setLang } = useI18n();
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  if (!user) return null;
  const initials = user.fullName.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  return (
    <div className="relative">
      <button onClick={() => setOpen((o) => !o)} onBlur={() => setTimeout(() => setOpen(false), 150)} className="flex items-center gap-2 rounded-lg p-1 hover:bg-surface-3">
        <span className="flex size-8 items-center justify-center rounded-full bg-brand-soft text-xs font-semibold text-brand-fg">{initials}</span>
        <span className="hidden text-left md:block">
          <span className="block text-sm leading-tight font-medium text-fg">{user.fullName}</span>
          <span className="block text-[11px] leading-tight text-muted">{t(ROLE_LABEL[user.role])}</span>
        </span>
      </button>
      {open && (
        <div className="absolute top-11 right-0 z-50 w-56 overflow-hidden rounded-xl border border-line bg-surface py-1 shadow-xl">
          <div className="border-b border-line px-3 py-2 text-xs text-muted">
            {t('Signed in as')} <span className="font-medium text-fg">{user.username}</span>
          </div>
          <button onMouseDown={(e) => e.preventDefault()} onClick={() => (setOpen(false), navigate('/profile'))} className="flex w-full items-center gap-2 px-3 py-2 text-sm text-fg-2 hover:bg-surface-3 hover:text-fg">
            <KeyRound className="size-4" /> {t('Change password')}
          </button>
          <button onMouseDown={(e) => e.preventDefault()} onClick={() => setLang(lang === 'el' ? 'en' : 'el')} className="flex w-full items-center gap-2 px-3 py-2 text-sm text-fg-2 hover:bg-surface-3 hover:text-fg">
            <span className="w-4 text-center text-xs font-bold">{lang === 'el' ? 'EN' : 'ΕΛ'}</span> {lang === 'el' ? 'English' : 'Ελληνικά'}
          </button>
          <button onMouseDown={(e) => e.preventDefault()} onClick={() => void logout()} className="flex w-full items-center gap-2 px-3 py-2 text-sm text-bad hover:bg-bad-soft">
            <LogOut className="size-4" /> {t('Sign out')}
          </button>
        </div>
      )}
    </div>
  );
}

export function Layout() {
  const { t } = useI18n();
  const { theme, toggle } = useTheme();
  const [sidebar, setSidebar] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const override = useScanOverride();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  useRealtime(queryClient, (version) =>
    toast.info(t('A new version ({v}) is available. Reload to use it.', { v: version }), {
      duration: Number.POSITIVE_INFINITY,
      action: { label: t('Reload'), onClick: () => window.location.reload() },
    }),
  );
  const live = useLiveStatus();

  // A scan made while no field has focus: pages may take it over (scanner,
  // stock in/out); otherwise open the product.
  const onGlobalScan = useCallback(
    async (code: string) => {
      if (override.current) return override.current(code);
      const res = await api.get<{ data: Product[] }>('/products/lookup', { code }).catch(() => ({ data: [] as Product[] }));
      if (res.data.length >= 1) {
        beep('ok');
        navigate(`/products/${res.data[0].id}`);
      } else {
        beep('error');
        toast.error(t('No product found for barcode {code}', { code }));
      }
    },
    [navigate, override, t],
  );
  useGlobalScan(onGlobalScan);

  useEffect(() => setSidebar(false), [location.pathname]);

  return (
    <div className="min-h-full">
      <Sidebar open={sidebar} onClose={() => setSidebar(false)} />
      <div className="lg:pl-64">
        <header className="no-print sticky top-0 z-20 flex h-14 items-center gap-2 border-b border-line bg-surface/90 px-3 backdrop-blur sm:gap-3 sm:px-5">
          <button className="rounded-lg p-2 text-fg-2 hover:bg-surface-3 lg:hidden" onClick={() => setSidebar(true)} aria-label={t('Menu')}>
            <Menu className="size-5" />
          </button>
          <GlobalSearch />
          <div className="ml-auto flex items-center gap-1">
            <span
              className="hidden items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium text-fg-2 md:flex"
              role="status"
              aria-live="polite"
              title={t('Changes from other PCs appear automatically')}
            >
              <span
                className={clsx(
                  'size-2 rounded-full',
                  live === 'live' ? 'bg-ok' : live === 'offline' ? 'bg-bad' : 'bg-warn animate-pulse',
                )}
              />
              {live === 'live'
                ? t('Live')
                : live === 'offline'
                  ? t('Offline')
                  : live === 'reconnecting'
                    ? t('Reconnecting…')
                    : t('Connecting…')}
            </span>
            <button onClick={() => navigate('/scanner')} className="hidden items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm font-medium text-fg-2 hover:bg-surface-3 hover:text-fg sm:flex" title={t('Barcode Scanner')}>
              <ScanBarcode className="size-4" />
              <span className="hidden xl:inline">{t('Scan')}</span>
            </button>
            <button onClick={toggle} className="rounded-lg p-2 text-fg-2 hover:bg-surface-3 hover:text-fg" aria-label={t('Toggle dark mode')} title={t('Toggle dark mode')}>
              {theme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
            </button>
            <UserMenu />
          </div>
        </header>
        <main className="mx-auto max-w-[1600px] px-4 py-5 sm:px-6 sm:py-6">
          {user?.mustChangePassword && location.pathname !== '/profile' && (
            <div className="no-print mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-warn/30 bg-warn-soft px-4 py-2.5 text-sm text-warn">
              <KeyRound className="size-4 shrink-0" />
              <span className="flex-1">{t('You are using a temporary or default password. Change it now so nobody else can sign in as you.')}</span>
              <button onClick={() => navigate('/profile')} className="rounded-md bg-surface px-3 py-1 font-semibold text-fg shadow-xs hover:bg-surface-3">
                {t('Change password')}
              </button>
            </div>
          )}
          <ErrorBoundary resetKey={location.pathname}>
            <Outlet />
          </ErrorBoundary>
        </main>
      </div>
    </div>
  );
}
