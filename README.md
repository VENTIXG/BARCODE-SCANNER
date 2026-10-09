# Warehouse IMS — Inventory Management System

A complete warehouse / inventory management application with barcode scanning,
Excel import/export and a full, immutable audit trail of every stock movement.

- **Backend:** Node.js 22, Express 5, SQLite (better-sqlite3, WAL mode, FTS5 search), Zod validation
- **Frontend:** React 19, Vite, Tailwind CSS 4, TanStack Query, Recharts, SheetJS
- **Auth:** bcrypt-hashed passwords, JWT in an `httpOnly` / `SameSite=Strict` cookie, role-based permissions
- **UI language:** Greek (default) and English, light / dark theme, desktop-first but usable on tablets and phones

---

## Quick start (development)

```bash
npm install          # installs server + client (npm workspaces)
npm run seed         # optional: demo data (78 products, 12 months of movements)
npm run dev          # API on :4000, web app on http://localhost:5173
```

Demo accounts created by `npm run seed`:

| User         | Password       | Role            |
|--------------|----------------|-----------------|
| `admin`      | `admin123`     | ADMIN           |
| `manager`    | `manager123`   | MANAGER         |
| `warehouse1` | `warehouse123` | WAREHOUSE USER  |
| `warehouse2` | `warehouse123` | WAREHOUSE USER  |

Without the seed, an empty database is created on first start with a single
`admin` user (password from `ADMIN_PASSWORD`, default `admin123`). **Change it after the first login.**

`npm run seed -- --reset` deletes the database and recreates the demo data.

## Windows desktop app (recommended for a single PC)

The app also ships as a normal Windows program: an installer (`Warehouse-IMS-Setup-<version>.exe`),
a desktop shortcut, its own window, no Node.js and no browser needed.

**Download:** https://github.com/VENTIXG/BARCODE-SCANNER/releases/latest/download/Warehouse-IMS-Setup.exe
(permanent link to the latest version, no GitHub account needed).

**Install:** run `Warehouse-IMS-Setup.exe`. The installer is not code-signed yet, so Windows
SmartScreen may say *"Windows protected your PC"*: click **More info → Run anyway**.
First sign-in: `admin` / `admin123`; you are asked to change the password, and an empty
database offers **Load demo data** or **Excel import**.

**Where things are**

| What | Where |
|---|---|
| Program | `%LOCALAPPDATA%\Programs\Warehouse IMS` (or the folder chosen during setup) |
| Database, photos | `%APPDATA%\Warehouse IMS\data` (*File → Open data folder*) |
| Backups | `%APPDATA%\Warehouse IMS\data\backups`, or the folder set in *Settings → Backups* |
| Log file | `%APPDATA%\Warehouse IMS\logs\main.log` (*File → Open log file*) |

Uninstalling or installing a newer version keeps the data folder.

**Backups:** a full copy of the database is taken automatically once a day (also when the app is
closed and a backup is due), the last 30 are kept. *Settings → Backups* has *Back up now*, a folder
picker (choose a USB stick, second disk or OneDrive folder), download and **restore** — restoring
first saves the current data, so it can be undone.

**Build the installer yourself**

- Automatically: every push runs the *Windows installer* GitHub Actions workflow on a Windows
  machine. On the default branch it also creates/refreshes the GitHub Release `v<version>`
  (version from `package.json`; bump it to publish a new release). Other branches: download the
  `.exe` from the run's *Artifacts*.
- On a Windows PC: `npm install` then `npm run desktop:win` → `desktop/release/`.
- On Linux/macOS the same command works without Wine (see `desktop/scripts/build-win.cjs`).
- Try the desktop app without building an installer: `npm run desktop`.

## Server mode (several PCs, one database)

One server runs the app; every PC uses it from its browser. Changes appear on all
open screens immediately. Installation with Docker and HTTPS, backups, updates and
rollback: **[deploy/DEPLOY.md](deploy/DEPLOY.md)** (in Greek).

```bash
cp .env.example .env     # DOMAIN, JWT_SECRET, ADMIN_PASSWORD
docker compose up -d --build
deploy/update.sh v1.2.0  # later: update (copies the database first, rolls back on failure)
```

## Tests

```bash
npm test             # 37 unit / API tests (real SQLite database, real HTTP)
npm run e2e          # two PCs (two browsers) against one real server, incl. server restart
npm run typecheck
```

CI (`.github/workflows/ci.yml`) runs all of the above on every push. The Windows installer
is built by `.github/workflows/windows-installer.yml`.

---

## Features

| Area | What it does |
|---|---|
| **Dashboard** | Total products, stock units, inventory value, low / out of stock, today's stock in/out, transactions today; charts for Stock IN vs OUT per month, movements of the last 30 days, inventory value trend, products by category; recent transactions and low-stock alerts. |
| **Products** | Barcode/EAN/UPC, SKU, name, description, category, supplier, unit, stock, minimum stock, location, purchase/selling price, photo, status, created/updated dates. Server-side paging, sorting and filtering (category, supplier, zone, location, stock level, status). Duplicate SKUs are rejected; a duplicate barcode needs explicit confirmation (e.g. variants sharing an EAN), and scanning it then asks which product is meant. |
| **Product page** | All details, stock KPIs, stock-level chart and the complete chronological **stock history** (previous qty, change, new qty, user, reference, notes). |
| **Barcode scanner** | STOCK IN / STOCK OUT / LOOKUP modes; *1 per scan*, *fixed quantity* or *ask quantity*; continuous scanning of different products; the input keeps focus automatically; big product card (photo, name, SKU, barcode, stock, location); session log with **Undo** (30 min); sound feedback; "create product with this barcode" for unknown codes. |
| **Stock In (goods receipt)** | Receipt number, date, supplier, invoice/delivery note, comments, user; scan/type/search products into lines (re-scanning increases the qty); unit costs, optional purchase-price update; **Confirm Receipt** posts every line in one DB transaction. Drafts survive a page reload. |
| **Stock Out (dispatch)** | Dispatch number, customer/recipient, reference, date, comments, user; live "available / remaining" per line with clear warnings; **Confirm Dispatch** is all-or-nothing and never allows negative stock (unless an admin explicitly enables it in Settings). |
| **Documents** | History, printable receipt/dispatch notes, cancellation by managers (posts reversal transactions — nothing is deleted). |
| **Inventory** | Stock by location with zone/location filters; **Inventory adjustment** (physical count → difference is posted as `ADJUSTMENT_PLUS/MINUS` with a reason), manual +/−, customer returns (`RETURN_IN`) and returns to supplier (`RETURN_OUT`); **stock count** mode (scan products, type counted quantities, post all differences); warehouse **locations** management (`A-01-03` = Zone-Rack-Shelf). |
| **Low stock** | `stock ≤ minimum` → **LOW STOCK**, `stock = 0` → **OUT OF STOCK**, with badges everywhere; dedicated page with shortage and suggested order quantity; "Receive selected" pre-fills a goods receipt. |
| **Transactions** | Filterable ledger (date range, type, user, product/reference) with Excel export and reversal for managers. |
| **Excel import** | `.xlsx`, `.xls`, `.csv`; automatic column detection (English and Greek headers) with manual mapping; server-side validation (required fields, numbers incl. decimal comma, duplicates inside the file and against the database, barcode conflicts); preview with per-row errors/warnings; import only valid rows; duplicate handling **Skip / Update existing / Ask me** (per-row); what to do with quantities of existing products; auto-create categories/suppliers/locations; result summary (Imported / Updated / Skipped / Errors); **Download Excel Template**. |
| **Excel export** | All products (re-importable layout), current inventory, low stock, stock movement history, Stock IN, Stock OUT, receipt lines, dispatch lines, products per category and per supplier (one sheet each + summary). |
| **Reports** | Period report: received/dispatched units, returns, adjustments, IN vs OUT per day, top dispatched/received products, movements by type, activity by user, adjustments list, stock without sales; stock valuation by category / supplier / zone. |
| **Global search** | Barcode, SKU, product name, supplier, category — full-text index (accent-insensitive, works for Greek); scanning into the search box opens the product. Press `/` to focus it. |
| **Users & roles** | ADMIN (everything), MANAGER (products, inventory, adjustments, import/export, reports, activity log), WAREHOUSE USER (scanner, stock in/out, product lookup). Deactivation / role change / password reset signs the user out immediately. |
| **Activity log** | User, action, product, previous value, new value, date, time, IP and user agent — e.g. *"admin changed minimum stock from "10" to "20" on ABC123"*, *"warehouse1 added 30 units to ABC123"*. Login attempts are logged too. |

### Barcode scanners

USB and Bluetooth scanners in **keyboard (HID) mode** work without drivers.
Configure the scanner to send **Enter** (or Tab) after each code.

- On the Scanner, Stock In, Stock Out and Stock count screens the scan field keeps focus, so you can scan continuously without touching the mouse.
- If focus is lost, fast keystroke bursts are still recognised as scans (anywhere in the app a scan opens the product).
- Tip: print the scanner's "Enter suffix" configuration barcode from its manual.

---

## Architecture

```
client/                 React SPA (Vite)
  src/pages/            one file per screen
  src/components/       UI kit, layout, scanner input, charts
  src/lib/              API client, auth, i18n (el.ts = Greek), scanner detection, formatting
server/
  src/db/migrations.ts  schema (versioned migrations)
  src/db/seed.ts        demo data
  src/lib/stock.ts      the stock ledger — the ONLY code that changes stock
  src/lib/importer.ts   Excel import validation + import
  src/routes/           REST API
  tests/                API integration tests
```

### Stock ledger

Stock is never edited directly. Every change goes through `applyStockChange()`,
which in a single SQLite transaction:

1. reads the current quantity (`inventory` row for product + warehouse),
2. computes the new quantity and refuses to go below zero (`409 INSUFFICIENT_STOCK`),
3. updates `inventory.quantity`,
4. inserts an immutable `inventory_transactions` row
   (`quantity_before`, signed `quantity_change`, `quantity_after`, type, user, reference, notes, source document),
5. writes an `audit_logs` entry.

A database `CHECK` guarantees `before + change = after` on every transaction row.
Corrections are made with new transactions (adjustments / reversals); history is never rewritten.

Transaction types: `STOCK_IN`, `STOCK_OUT`, `ADJUSTMENT_PLUS`, `ADJUSTMENT_MINUS`, `RETURN_IN`, `RETURN_OUT`, `INITIAL_STOCK`.

### Database

| Table | Purpose |
|---|---|
| `users` | accounts, bcrypt hash, role, active flag, token version (instant session revocation) |
| `products` | catalog; `sku` UNIQUE, indexes on barcode, name, category, supplier, status |
| `products_fts` | FTS5 full-text index (maintained by triggers) for fast search over thousands of products |
| `categories`, `suppliers` | reference data |
| `warehouses` | multi-warehouse ready (one default warehouse used by the UI today) |
| `warehouse_locations` | `ZONE-RACK-SHELF` per warehouse, UNIQUE(warehouse, code) |
| `inventory` | current quantity + location per product **per warehouse**, UNIQUE(product, warehouse) |
| `inventory_transactions` | the ledger (see above), indexed by product/date, date, type/date, user, source |
| `stock_receipts`, `stock_receipt_items` | goods receipts |
| `stock_dispatches`, `stock_dispatch_items` | dispatches |
| `audit_logs` | activity log with old/new values (JSON), IP, user agent |
| `settings`, `sequences` | app settings, document numbering (`RCV-2026-00001`, `DSP-2026-00001`) |

All tables have primary keys, foreign keys (enforced), `CHECK` constraints and
`created_at` / `updated_at` where applicable. Supporting a second warehouse needs
UI work only (every stock row and transaction already carries `warehouse_id`).

### Security

- Passwords hashed with bcrypt; login rate-limited; constant-time path for unknown users.
- Session: signed JWT in an `httpOnly`, `SameSite=Strict` cookie (`COOKIE_SECURE=true` over HTTPS). The user is re-loaded on every request, so disabled users / role changes take effect immediately.
- Authorization is enforced on the server for every endpoint (`requirePermission`), the UI only hides what a role cannot do.
- All input validated with Zod; SQL uses bound parameters only; Helmet CSP; uploads limited to images ≤ 5 MB and served only to signed-in users.

### Main API endpoints

`POST /api/auth/login` · `GET /api/auth/me` ·
`GET|POST /api/products` · `GET|PUT|DELETE /api/products/:id` · `GET /api/products/lookup?code=` ·
`POST /api/stock/scan` · `POST /api/stock/adjust` · `POST /api/stock/count` ·
`GET|POST /api/receipts` · `GET|POST /api/dispatches` · `POST /api/{receipts|dispatches}/:id/cancel` ·
`GET /api/transactions` · `POST /api/transactions/:id/reverse` ·
`POST /api/import/products/validate` · `POST /api/import/products/commit` · `GET /api/import/template` ·
`GET /api/export/{products|inventory|low-stock|transactions|documents/:kind|grouped/:by}` ·
`GET /api/dashboard` · `GET /api/reports/{movements|valuation}` · `GET /api/search?q=` · `GET /api/audit` ·
`GET|POST /api/backups` · `POST /api/backups/:file/restore` · `POST /api/backups/restore-upload` · `POST /api/settings/demo-data`
