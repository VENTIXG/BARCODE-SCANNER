import { lazy, Suspense, type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Layout } from './components/Layout';
import { EmptyState, LoadingBlock } from './components/ui';
import { useAuth } from './lib/auth';
import { useT } from './lib/i18n';
import { LoginPage } from './pages/Login';

const Dashboard = lazy(() => import('./pages/Dashboard'));
const Products = lazy(() => import('./pages/Products'));
const ProductDetail = lazy(() => import('./pages/ProductDetail'));
const ProductForm = lazy(() => import('./pages/ProductForm'));
const Scanner = lazy(() => import('./pages/Scanner'));
const StockDocumentPage = lazy(() => import('./pages/StockDocument'));
const DocumentView = lazy(() => import('./pages/DocumentView'));
const Inventory = lazy(() => import('./pages/Inventory'));
const LowStock = lazy(() => import('./pages/LowStock'));
const Transactions = lazy(() => import('./pages/Transactions'));
const Suppliers = lazy(() => import('./pages/Suppliers'));
const Categories = lazy(() => import('./pages/Categories'));
const ImportExport = lazy(() => import('./pages/ImportExport'));
const Reports = lazy(() => import('./pages/Reports'));
const ActivityLog = lazy(() => import('./pages/ActivityLog'));
const UsersPage = lazy(() => import('./pages/Users'));
const SettingsPage = lazy(() => import('./pages/Settings'));
const Profile = lazy(() => import('./pages/Profile'));

function Guard({ permission, children }: { permission?: string; children: ReactNode }) {
  const { can } = useAuth();
  const t = useT();
  if (permission && !can(permission))
    return <EmptyState title={t('Access denied')} description={t('You do not have permission to view this page.')} />;
  return <>{children}</>;
}

export function App() {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <LoadingBlock />;
  if (!user)
    return (
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="*" element={<Navigate to="/login" replace state={{ from: location.pathname + location.search }} />} />
      </Routes>
    );

  const g = (el: ReactNode, permission?: string) => (
    <Guard permission={permission}>
      <Suspense fallback={<LoadingBlock />}>{el}</Suspense>
    </Guard>
  );

  return (
    <Routes>
      <Route path="/login" element={<Navigate to={(location.state as { from?: string })?.from ?? '/'} replace />} />
      <Route element={<Layout />}>
        <Route index element={g(<Dashboard />, 'dashboard.view')} />
        <Route path="products" element={g(<Products />, 'products.view')} />
        <Route path="products/new" element={g(<ProductForm />, 'products.manage')} />
        <Route path="products/:id" element={g(<ProductDetail />, 'products.view')} />
        <Route path="products/:id/edit" element={g(<ProductForm />, 'products.manage')} />
        <Route path="scanner" element={g(<Scanner />, 'stock.scan')} />
        <Route path="stock-in" element={g(<StockDocumentPage kind="receipt" />, 'stock.in')} />
        <Route path="stock-in/:id" element={g(<DocumentView kind="receipt" />, 'stock.in')} />
        <Route path="stock-out" element={g(<StockDocumentPage kind="dispatch" />, 'stock.out')} />
        <Route path="stock-out/:id" element={g(<DocumentView kind="dispatch" />, 'stock.out')} />
        <Route path="inventory" element={g(<Inventory />, 'inventory.view')} />
        <Route path="low-stock" element={g(<LowStock />, 'products.view')} />
        <Route path="transactions" element={g(<Transactions />, 'transactions.view')} />
        <Route path="suppliers" element={g(<Suppliers />, 'catalog.view')} />
        <Route path="categories" element={g(<Categories />, 'catalog.view')} />
        <Route path="import-export" element={g(<ImportExport />, 'import.run')} />
        <Route path="reports" element={g(<Reports />, 'reports.view')} />
        <Route path="activity" element={g(<ActivityLog />, 'audit.view')} />
        <Route path="users" element={g(<UsersPage />, 'users.manage')} />
        <Route path="settings" element={g(<SettingsPage />)} />
        <Route path="profile" element={g(<Profile />)} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
