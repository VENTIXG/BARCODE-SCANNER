export type Role = 'ADMIN' | 'MANAGER' | 'WAREHOUSE_USER';
export const ROLES: Role[] = ['ADMIN', 'MANAGER', 'WAREHOUSE_USER'];

/**
 * Role -> permission matrix. Keep in sync with client/src/lib/permissions.ts.
 */
const ALL: Role[] = ['ADMIN', 'MANAGER', 'WAREHOUSE_USER'];
const MGMT: Role[] = ['ADMIN', 'MANAGER'];
const ADMIN: Role[] = ['ADMIN'];

export const PERMISSIONS = {
  'dashboard.view': ALL,
  'products.view': ALL,
  'products.manage': MGMT,
  'products.delete': ADMIN,
  'stock.scan': ALL,
  'stock.in': ALL,
  'stock.out': ALL,
  'stock.adjust': MGMT,
  'inventory.view': ALL,
  'transactions.view': MGMT,
  'transactions.reverse': MGMT,
  'catalog.view': ALL, // categories, suppliers, locations
  'catalog.manage': MGMT,
  'import.run': MGMT,
  'export.run': MGMT,
  'reports.view': MGMT,
  'audit.view': MGMT,
  'users.manage': ADMIN,
  'settings.manage': ADMIN,
} as const satisfies Record<string, Role[]>;

export type Permission = keyof typeof PERMISSIONS;

export function can(role: Role, permission: Permission): boolean {
  return (PERMISSIONS[permission] as readonly Role[]).includes(role);
}
