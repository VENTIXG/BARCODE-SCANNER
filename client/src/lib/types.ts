export type Role = 'ADMIN' | 'MANAGER' | 'WAREHOUSE_USER';
export type StockStatus = 'IN_STOCK' | 'LOW_STOCK' | 'OUT_OF_STOCK';
export type TxType =
  | 'STOCK_IN'
  | 'STOCK_OUT'
  | 'ADJUSTMENT_PLUS'
  | 'ADJUSTMENT_MINUS'
  | 'RETURN_IN'
  | 'RETURN_OUT'
  | 'INITIAL_STOCK';
export const TX_TYPES: TxType[] = ['STOCK_IN', 'STOCK_OUT', 'ADJUSTMENT_PLUS', 'ADJUSTMENT_MINUS', 'RETURN_IN', 'RETURN_OUT', 'INITIAL_STOCK'];

export interface User {
  id: number;
  username: string;
  fullName: string;
  email: string | null;
  role: Role;
  permissions: string[];
}

export interface AppSettings {
  companyName: string;
  currency: string;
  allowNegativeStock: boolean;
  defaultUnit: string;
}

export interface Product {
  id: number;
  sku: string;
  barcode: string | null;
  name: string;
  description: string | null;
  categoryId: number | null;
  categoryName: string | null;
  supplierId: number | null;
  supplierName: string | null;
  unit: string;
  quantity: number;
  minStock: number;
  locationId: number | null;
  locationCode: string | null;
  purchasePrice: number;
  sellingPrice: number;
  imageUrl: string | null;
  status: 'ACTIVE' | 'INACTIVE';
  stockStatus: StockStatus;
  createdAt: string;
  updatedAt: string;
}

export interface Transaction {
  id: number;
  product_id: number;
  type: TxType;
  quantity_before: number;
  quantity_change: number;
  quantity_after: number;
  unit_cost: number | null;
  reference: string | null;
  notes: string | null;
  source_type: string;
  source_id: number | null;
  reversal_of_id: number | null;
  reversed_by_id?: number | null;
  user_id: number | null;
  created_at: string;
  sku?: string;
  product_name?: string;
  barcode?: string | null;
  unit?: string;
  username?: string | null;
  user_full_name?: string | null;
}

export interface Category {
  id: number;
  name: string;
  description: string | null;
  product_count: number;
  total_quantity: number;
  stock_value: number;
}

export interface Supplier {
  id: number;
  name: string;
  contact_name: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  vat_number: string | null;
  notes: string | null;
  is_active: number;
  product_count: number;
  stock_value: number;
  last_receipt_date: string | null;
}

export interface Location {
  id: number;
  code: string;
  zone: string | null;
  rack: string | null;
  shelf: string | null;
  description: string | null;
  is_active: number;
  product_count: number;
  total_quantity: number;
}

export interface DocumentLine {
  id: number;
  product_id: number;
  quantity: number;
  unit_price: number | null;
  notes: string | null;
  sku: string;
  barcode: string | null;
  name: string;
  unit: string;
}

export interface StockDocument {
  id: number;
  number: string;
  date: string;
  status: 'DRAFT' | 'CONFIRMED' | 'CANCELLED';
  notes: string | null;
  total_quantity: number;
  total_value: number;
  created_by_username: string | null;
  created_by_name?: string | null;
  confirmed_at: string | null;
  created_at: string;
  item_count?: number;
  // receipts
  supplier_id?: number | null;
  supplier_name?: string | null;
  invoice_number?: string | null;
  // dispatches
  customer_name?: string | null;
  reference?: string | null;
  items?: DocumentLine[];
}

export interface AuditEntry {
  id: number;
  user_id: number | null;
  username: string | null;
  action: string;
  entity_type: string | null;
  entity_id: number | null;
  product_id: number | null;
  product_sku: string | null;
  product_name: string | null;
  description: string;
  old_value: string | null;
  new_value: string | null;
  ip_address: string | null;
  user_agent: string | null;
  created_at: string;
}

export interface UserRow {
  id: number;
  username: string;
  full_name: string;
  email: string | null;
  role: Role;
  is_active: number;
  last_login_at: string | null;
  created_at: string;
}
