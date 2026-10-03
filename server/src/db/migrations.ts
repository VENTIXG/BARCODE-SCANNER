/**
 * Database schema, applied as ordered migrations.
 * Each migration runs once; the applied version is tracked in `schema_migrations`.
 */
export const migrations: { version: number; name: string; sql: string }[] = [
  {
    version: 1,
    name: 'initial_schema',
    sql: /* sql */ `
    CREATE TABLE users (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      username        TEXT    NOT NULL COLLATE NOCASE UNIQUE,
      full_name       TEXT    NOT NULL,
      email           TEXT    COLLATE NOCASE,
      password_hash   TEXT    NOT NULL,
      role            TEXT    NOT NULL CHECK (role IN ('ADMIN','MANAGER','WAREHOUSE_USER')),
      is_active       INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
      token_version   INTEGER NOT NULL DEFAULT 0,
      last_login_at   TEXT,
      created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    CREATE TABLE categories (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      name         TEXT    NOT NULL COLLATE NOCASE UNIQUE,
      description  TEXT,
      created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    CREATE TABLE suppliers (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      name          TEXT    NOT NULL COLLATE NOCASE UNIQUE,
      contact_name  TEXT,
      email         TEXT,
      phone         TEXT,
      address       TEXT,
      vat_number    TEXT,
      notes         TEXT,
      is_active     INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
      created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    -- Multi-warehouse ready: every stock figure is scoped to a warehouse.
    CREATE TABLE warehouses (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      code        TEXT    NOT NULL COLLATE NOCASE UNIQUE,
      name        TEXT    NOT NULL,
      address     TEXT,
      is_default  INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0,1)),
      is_active   INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
      created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE UNIQUE INDEX ux_warehouses_single_default ON warehouses(is_default) WHERE is_default = 1;

    -- Location code format: ZONE-RACK-SHELF, e.g. A-01-03
    CREATE TABLE warehouse_locations (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      warehouse_id  INTEGER NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
      code          TEXT    NOT NULL COLLATE NOCASE,
      zone          TEXT,
      rack          TEXT,
      shelf         TEXT,
      description   TEXT,
      is_active     INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
      created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      UNIQUE (warehouse_id, code)
    );
    CREATE INDEX ix_locations_zone ON warehouse_locations(warehouse_id, zone, rack);

    CREATE TABLE products (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      sku             TEXT    NOT NULL COLLATE NOCASE UNIQUE,
      -- Barcode duplicates are rejected by the application unless explicitly
      -- confirmed (e.g. the same EAN on product variants), so no UNIQUE here.
      barcode         TEXT    COLLATE NOCASE,
      name            TEXT    NOT NULL,
      description     TEXT,
      category_id     INTEGER REFERENCES categories(id) ON DELETE SET NULL,
      supplier_id     INTEGER REFERENCES suppliers(id) ON DELETE SET NULL,
      unit            TEXT    NOT NULL DEFAULT 'pcs',
      min_stock       REAL    NOT NULL DEFAULT 0 CHECK (min_stock >= 0),
      purchase_price  REAL    NOT NULL DEFAULT 0 CHECK (purchase_price >= 0),
      selling_price   REAL    NOT NULL DEFAULT 0 CHECK (selling_price >= 0),
      image_path      TEXT,
      status          TEXT    NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
      created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX ix_products_barcode  ON products(barcode);
    CREATE INDEX ix_products_name     ON products(name COLLATE NOCASE);
    CREATE INDEX ix_products_category ON products(category_id);
    CREATE INDEX ix_products_supplier ON products(supplier_id);
    CREATE INDEX ix_products_status   ON products(status);

    -- Full-text index for fast product search. The indexed text is normalised
    -- by ims_norm() (lower-case, accents removed - important for Greek), which
    -- is registered on every connection in db/index.ts.
    CREATE VIRTUAL TABLE products_fts USING fts5(
      body,
      tokenize = "unicode61 remove_diacritics 2",
      prefix = '2 3'
    );
    CREATE TRIGGER products_ai AFTER INSERT ON products BEGIN
      INSERT INTO products_fts(rowid, body)
      VALUES (new.id, ims_norm(new.name || ' ' || new.sku || ' ' || coalesce(new.barcode,'') || ' ' || coalesce(new.description,'')));
    END;
    CREATE TRIGGER products_ad AFTER DELETE ON products BEGIN
      DELETE FROM products_fts WHERE rowid = old.id;
    END;
    CREATE TRIGGER products_au AFTER UPDATE OF name, sku, barcode, description ON products BEGIN
      DELETE FROM products_fts WHERE rowid = old.id;
      INSERT INTO products_fts(rowid, body)
      VALUES (new.id, ims_norm(new.name || ' ' || new.sku || ' ' || coalesce(new.barcode,'') || ' ' || coalesce(new.description,'')));
    END;

    -- Current stock per product per warehouse. Only changed through
    -- inventory_transactions (see lib/stock.ts), never directly.
    CREATE TABLE inventory (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id    INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      warehouse_id  INTEGER NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
      location_id   INTEGER REFERENCES warehouse_locations(id) ON DELETE SET NULL,
      quantity      REAL    NOT NULL DEFAULT 0,
      created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      UNIQUE (product_id, warehouse_id)
    );
    CREATE INDEX ix_inventory_warehouse ON inventory(warehouse_id, quantity);
    CREATE INDEX ix_inventory_location  ON inventory(location_id);

    CREATE TABLE stock_receipts (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      receipt_number  TEXT    NOT NULL UNIQUE,
      warehouse_id    INTEGER NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
      supplier_id     INTEGER REFERENCES suppliers(id) ON DELETE SET NULL,
      invoice_number  TEXT,
      receipt_date    TEXT    NOT NULL,
      status          TEXT    NOT NULL DEFAULT 'CONFIRMED' CHECK (status IN ('DRAFT','CONFIRMED','CANCELLED')),
      notes           TEXT,
      total_quantity  REAL    NOT NULL DEFAULT 0,
      total_value     REAL    NOT NULL DEFAULT 0,
      created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
      confirmed_at    TEXT,
      created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX ix_receipts_date     ON stock_receipts(receipt_date);
    CREATE INDEX ix_receipts_supplier ON stock_receipts(supplier_id);

    CREATE TABLE stock_receipt_items (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      receipt_id   INTEGER NOT NULL REFERENCES stock_receipts(id) ON DELETE CASCADE,
      product_id   INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
      quantity     REAL    NOT NULL CHECK (quantity > 0),
      unit_cost    REAL    CHECK (unit_cost IS NULL OR unit_cost >= 0),
      notes        TEXT,
      created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX ix_receipt_items_receipt ON stock_receipt_items(receipt_id);
    CREATE INDEX ix_receipt_items_product ON stock_receipt_items(product_id);

    CREATE TABLE stock_dispatches (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      dispatch_number  TEXT    NOT NULL UNIQUE,
      warehouse_id     INTEGER NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
      customer_name    TEXT,
      reference        TEXT,
      dispatch_date    TEXT    NOT NULL,
      status           TEXT    NOT NULL DEFAULT 'CONFIRMED' CHECK (status IN ('DRAFT','CONFIRMED','CANCELLED')),
      notes            TEXT,
      total_quantity   REAL    NOT NULL DEFAULT 0,
      total_value      REAL    NOT NULL DEFAULT 0,
      created_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
      confirmed_at     TEXT,
      created_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX ix_dispatches_date ON stock_dispatches(dispatch_date);

    CREATE TABLE stock_dispatch_items (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      dispatch_id  INTEGER NOT NULL REFERENCES stock_dispatches(id) ON DELETE CASCADE,
      product_id   INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
      quantity     REAL    NOT NULL CHECK (quantity > 0),
      unit_price   REAL    CHECK (unit_price IS NULL OR unit_price >= 0),
      notes        TEXT,
      created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX ix_dispatch_items_dispatch ON stock_dispatch_items(dispatch_id);
    CREATE INDEX ix_dispatch_items_product  ON stock_dispatch_items(product_id);

    -- Immutable ledger: every stock change is one row here.
    CREATE TABLE inventory_transactions (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id        INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      warehouse_id      INTEGER NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
      type              TEXT    NOT NULL CHECK (type IN (
                          'STOCK_IN','STOCK_OUT','ADJUSTMENT_PLUS','ADJUSTMENT_MINUS',
                          'RETURN_IN','RETURN_OUT','INITIAL_STOCK')),
      quantity_before   REAL    NOT NULL,
      quantity_change   REAL    NOT NULL CHECK (quantity_change <> 0),
      quantity_after    REAL    NOT NULL,
      unit_cost         REAL,
      reference         TEXT,
      notes             TEXT,
      source_type       TEXT    NOT NULL DEFAULT 'MANUAL' CHECK (source_type IN (
                          'RECEIPT','DISPATCH','SCAN','ADJUSTMENT','IMPORT','PRODUCT','REVERSAL','MANUAL')),
      source_id         INTEGER,
      reversal_of_id    INTEGER REFERENCES inventory_transactions(id) ON DELETE SET NULL,
      user_id           INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      CHECK (abs(quantity_before + quantity_change - quantity_after) < 0.0001)
    );
    CREATE INDEX ix_tx_product_date ON inventory_transactions(product_id, created_at);
    CREATE INDEX ix_tx_date         ON inventory_transactions(created_at);
    CREATE INDEX ix_tx_type_date    ON inventory_transactions(type, created_at);
    CREATE INDEX ix_tx_user         ON inventory_transactions(user_id);
    CREATE INDEX ix_tx_source       ON inventory_transactions(source_type, source_id);
    CREATE UNIQUE INDEX ux_tx_reversal ON inventory_transactions(reversal_of_id) WHERE reversal_of_id IS NOT NULL;

    CREATE TABLE audit_logs (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
      username     TEXT,
      action       TEXT    NOT NULL,
      entity_type  TEXT,
      entity_id    INTEGER,
      product_id   INTEGER REFERENCES products(id) ON DELETE SET NULL,
      description  TEXT    NOT NULL,
      old_value    TEXT,
      new_value    TEXT,
      ip_address   TEXT,
      user_agent   TEXT,
      created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX ix_audit_date    ON audit_logs(created_at);
    CREATE INDEX ix_audit_user    ON audit_logs(user_id, created_at);
    CREATE INDEX ix_audit_product ON audit_logs(product_id);
    CREATE INDEX ix_audit_action  ON audit_logs(action);

    CREATE TABLE settings (
      key         TEXT PRIMARY KEY,
      value       TEXT NOT NULL,
      updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    -- Document numbering (RCV-2026-00001, DSP-2026-00001)
    CREATE TABLE sequences (
      name   TEXT    NOT NULL,
      year   INTEGER NOT NULL,
      value  INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (name, year)
    );
    `,
  },
  {
    version: 2,
    name: 'users_must_change_password',
    sql: /* sql */ `
    ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0,1));
    `,
  },
];
