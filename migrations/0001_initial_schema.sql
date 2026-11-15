-- DepotPro CI — Migration 0001: Schéma relationnel fondamental
-- Règles strictes :
-- 1. Tous les montants financiers sont des entiers en FCFA (XOF) — aucun flottant.
-- 2. Toutes les transactions validées sont immuables (aucune suppression physique).
-- 3. Identifiants stables UUID v4 (TEXT) et champs sync_version/updated_at pour évolution cloud future.
-- 4. Séparation stricte : stock commercial != emballages consignés != créances commerciales != licence logicielle.

CREATE TABLE IF NOT EXISTS system_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'SYSTEM',
  description TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS license_state (
  id TEXT PRIMARY KEY,
  edition TEXT NOT NULL DEFAULT 'STANDARD_OFFLINE',
  status TEXT NOT NULL DEFAULT 'TRIAL_OFFLINE' CHECK (status IN ('TRIAL_OFFLINE', 'ACTIVE_OFFLINE', 'EXPIRED_GRACE')),
  license_key_masked TEXT,
  installation_id TEXT NOT NULL,
  depot_name_bound TEXT,
  activated_at TEXT,
  expires_at TEXT,
  offline_allowed INTEGER NOT NULL DEFAULT 1 CHECK (offline_allowed IN (0, 1)),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS business_settings (
  id TEXT PRIMARY KEY,
  depot_name TEXT NOT NULL,
  owner_name TEXT NOT NULL,
  phone TEXT,
  address TEXT,
  logo_path TEXT,
  currency TEXT NOT NULL DEFAULT 'XOF' CHECK (currency = 'XOF'),
  receipt_header TEXT,
  receipt_footer TEXT,
  default_consignment_policy TEXT NOT NULL DEFAULT 'SEPARATE_TRACKING',
  allow_negative_stock INTEGER NOT NULL DEFAULT 0 CHECK (allow_negative_stock IN (0, 1)),
  is_initialized INTEGER NOT NULL DEFAULT 0 CHECK (is_initialized IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  sync_version INTEGER NOT NULL DEFAULT 1
);

-- MODULE 1 & 11 : Authentification, Rôles, Permissions, Employés
CREATE TABLE IF NOT EXISTS roles (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  is_system INTEGER NOT NULL DEFAULT 1 CHECK (is_system IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS permissions (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  module TEXT NOT NULL,
  description TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id TEXT NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE IF NOT EXISTS employees (
  id TEXT PRIMARY KEY,
  full_name TEXT NOT NULL,
  phone TEXT,
  job_title TEXT,
  hire_date TEXT,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  sync_version INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  employee_id TEXT REFERENCES employees(id) ON DELETE RESTRICT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  locked_until TEXT,
  last_login_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  sync_version INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS login_logs (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  username_attempted TEXT NOT NULL,
  success INTEGER NOT NULL CHECK (success IN (0, 1)),
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- MODULE 3 : Produits, Marques, Catégories, Unités, Conditionnements
CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  sync_version INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS brands (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  sync_version INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS units (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL UNIQUE,
  is_base_unit INTEGER NOT NULL DEFAULT 0 CHECK (is_base_unit IN (0, 1))
);

CREATE TABLE IF NOT EXISTS packaging_types (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('BOTTLE', 'CRATE', 'OTHER')),
  deposit_amount_xof INTEGER NOT NULL DEFAULT 0 CHECK (deposit_amount_xof >= 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  sync_version INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  sku TEXT NOT NULL UNIQUE,
  barcode TEXT UNIQUE,
  name TEXT NOT NULL,
  category_id TEXT REFERENCES categories(id) ON DELETE RESTRICT,
  brand_id TEXT REFERENCES brands(id) ON DELETE RESTRICT,
  format_label TEXT,
  base_unit_id TEXT NOT NULL REFERENCES units(id) ON DELETE RESTRICT,
  packaging_type_id TEXT REFERENCES packaging_types(id) ON DELETE RESTRICT,
  purchase_price_xof INTEGER NOT NULL DEFAULT 0 CHECK (purchase_price_xof >= 0),
  weighted_avg_cost_xof INTEGER NOT NULL DEFAULT 0 CHECK (weighted_avg_cost_xof >= 0),
  wholesale_price_xof INTEGER NOT NULL DEFAULT 0 CHECK (wholesale_price_xof >= 0),
  retail_price_xof INTEGER NOT NULL DEFAULT 0 CHECK (retail_price_xof >= 0),
  alert_threshold_base INTEGER NOT NULL DEFAULT 0 CHECK (alert_threshold_base >= 0),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  sync_version INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS product_units (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  unit_id TEXT NOT NULL REFERENCES units(id) ON DELETE RESTRICT,
  conversion_to_base INTEGER NOT NULL CHECK (conversion_to_base >= 1),
  wholesale_price_xof INTEGER NOT NULL CHECK (wholesale_price_xof >= 0),
  retail_price_xof INTEGER NOT NULL CHECK (retail_price_xof >= 0),
  barcode TEXT UNIQUE,
  is_default_sale_unit INTEGER NOT NULL DEFAULT 0 CHECK (is_default_sale_unit IN (0, 1)),
  UNIQUE (product_id, unit_id)
);

-- MODULE 4 : Gestion des Stocks
CREATE TABLE IF NOT EXISTS stock_balances (
  product_id TEXT PRIMARY KEY REFERENCES products(id) ON DELETE RESTRICT,
  quantity_base INTEGER NOT NULL DEFAULT 0 CHECK (quantity_base >= 0),
  damaged_quantity_base INTEGER NOT NULL DEFAULT 0 CHECK (damaged_quantity_base >= 0),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS stock_movements (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  movement_type TEXT NOT NULL CHECK (movement_type IN (
    'INITIAL', 'PURCHASE_RECEIPT', 'SALE', 'SALE_CANCEL',
    'CUSTOMER_RETURN', 'SUPPLIER_RETURN', 'BREAKAGE', 'LOSS',
    'INVENTORY_ADJUSTMENT', 'MANUAL_IN', 'MANUAL_OUT'
  )),
  quantity_delta_base INTEGER NOT NULL CHECK (quantity_delta_base != 0),
  unit_cost_xof INTEGER NOT NULL DEFAULT 0 CHECK (unit_cost_xof >= 0),
  balance_after_base INTEGER NOT NULL CHECK (balance_after_base >= 0),
  reference_type TEXT,
  reference_id TEXT,
  note TEXT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  sync_version INTEGER NOT NULL DEFAULT 1
);

-- MODULE 5 : Fournisseurs et Achats
CREATE TABLE IF NOT EXISTS suppliers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT,
  address TEXT,
  tax_id TEXT,
  balance_due_xof INTEGER NOT NULL DEFAULT 0 CHECK (balance_due_xof >= 0),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  sync_version INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS purchase_orders (
  id TEXT PRIMARY KEY,
  order_number TEXT NOT NULL UNIQUE,
  supplier_id TEXT NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('DRAFT', 'VALIDATED', 'PARTIAL_RECEIVED', 'RECEIVED', 'CANCELLED')),
  total_amount_xof INTEGER NOT NULL DEFAULT 0 CHECK (total_amount_xof >= 0),
  paid_amount_xof INTEGER NOT NULL DEFAULT 0 CHECK (paid_amount_xof >= 0),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  ordered_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  sync_version INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS purchase_items (
  id TEXT PRIMARY KEY,
  purchase_order_id TEXT NOT NULL REFERENCES purchase_orders(id) ON DELETE RESTRICT,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  unit_id TEXT NOT NULL REFERENCES units(id) ON DELETE RESTRICT,
  ordered_qty INTEGER NOT NULL CHECK (ordered_qty >= 1),
  received_qty INTEGER NOT NULL DEFAULT 0 CHECK (received_qty >= 0),
  conversion_to_base INTEGER NOT NULL CHECK (conversion_to_base >= 1),
  unit_cost_xof INTEGER NOT NULL CHECK (unit_cost_xof >= 0),
  line_total_xof INTEGER NOT NULL CHECK (line_total_xof >= 0)
);

CREATE TABLE IF NOT EXISTS goods_receipts (
  id TEXT PRIMARY KEY,
  receipt_number TEXT NOT NULL UNIQUE,
  purchase_order_id TEXT NOT NULL REFERENCES purchase_orders(id) ON DELETE RESTRICT,
  supplier_id TEXT NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  total_received_xof INTEGER NOT NULL DEFAULT 0 CHECK (total_received_xof >= 0),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  note TEXT
);

CREATE TABLE IF NOT EXISTS goods_receipt_items (
  id TEXT PRIMARY KEY,
  goods_receipt_id TEXT NOT NULL REFERENCES goods_receipts(id) ON DELETE RESTRICT,
  purchase_item_id TEXT NOT NULL REFERENCES purchase_items(id) ON DELETE RESTRICT,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  received_qty INTEGER NOT NULL CHECK (received_qty >= 1),
  base_qty INTEGER NOT NULL CHECK (base_qty >= 1),
  unit_cost_xof INTEGER NOT NULL CHECK (unit_cost_xof >= 0)
);

-- MODULE 6 & 7 : Clients, Ventes, Paiements
CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY,
  full_name TEXT NOT NULL,
  customer_type TEXT NOT NULL CHECK (customer_type IN ('PARTICULIER', 'DETAILLANT', 'REVENDEUR', 'ENTREPRISE')),
  phone TEXT,
  address TEXT,
  credit_limit_xof INTEGER NOT NULL DEFAULT 0 CHECK (credit_limit_xof >= 0),
  commercial_debt_xof INTEGER NOT NULL DEFAULT 0 CHECK (commercial_debt_xof >= 0),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  sync_version INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS cash_registers (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1))
);

CREATE TABLE IF NOT EXISTS cash_sessions (
  id TEXT PRIMARY KEY,
  cash_register_id TEXT NOT NULL REFERENCES cash_registers(id) ON DELETE RESTRICT,
  opened_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  closed_by_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  opening_balance_xof INTEGER NOT NULL DEFAULT 0 CHECK (opening_balance_xof >= 0),
  theoretical_closing_xof INTEGER,
  declared_closing_xof INTEGER,
  variance_xof INTEGER,
  status TEXT NOT NULL CHECK (status IN ('OPEN', 'CLOSED')),
  opened_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  closed_at TEXT,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS sales (
  id TEXT PRIMARY KEY,
  sale_number TEXT NOT NULL UNIQUE,
  idempotency_key TEXT NOT NULL UNIQUE,
  customer_id TEXT REFERENCES customers(id) ON DELETE RESTRICT,
  cash_session_id TEXT REFERENCES cash_sessions(id) ON DELETE RESTRICT,
  price_tier TEXT NOT NULL CHECK (price_tier IN ('WHOLESALE', 'RETAIL')),
  subtotal_xof INTEGER NOT NULL CHECK (subtotal_xof >= 0),
  discount_xof INTEGER NOT NULL DEFAULT 0 CHECK (discount_xof >= 0),
  consignment_total_xof INTEGER NOT NULL DEFAULT 0 CHECK (consignment_total_xof >= 0),
  total_payable_xof INTEGER NOT NULL CHECK (total_payable_xof >= 0),
  paid_amount_xof INTEGER NOT NULL DEFAULT 0 CHECK (paid_amount_xof >= 0),
  credit_amount_xof INTEGER NOT NULL DEFAULT 0 CHECK (credit_amount_xof >= 0),
  status TEXT NOT NULL CHECK (status IN ('VALIDATED', 'CANCELLED')),
  cancelled_at TEXT,
  cancelled_by_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  cancel_reason TEXT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  sync_version INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS sale_items (
  id TEXT PRIMARY KEY,
  sale_id TEXT NOT NULL REFERENCES sales(id) ON DELETE RESTRICT,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  unit_id TEXT NOT NULL REFERENCES units(id) ON DELETE RESTRICT,
  quantity INTEGER NOT NULL CHECK (quantity >= 1),
  conversion_to_base INTEGER NOT NULL CHECK (conversion_to_base >= 1),
  base_qty INTEGER NOT NULL CHECK (base_qty >= 1),
  unit_price_xof INTEGER NOT NULL CHECK (unit_price_xof >= 0),
  unit_cost_xof INTEGER NOT NULL CHECK (unit_cost_xof >= 0),
  line_total_xof INTEGER NOT NULL CHECK (line_total_xof >= 0)
);

CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  payment_number TEXT NOT NULL UNIQUE,
  direction TEXT NOT NULL CHECK (direction IN ('INBOUND', 'OUTBOUND')),
  party_type TEXT NOT NULL CHECK (party_type IN ('CUSTOMER', 'SUPPLIER')),
  party_id TEXT,
  payment_method TEXT NOT NULL CHECK (payment_method IN ('CASH', 'ORANGE_MONEY', 'MTN_MOMO', 'MOOV_MONEY', 'WAVE', 'BANK_TRANSFER')),
  amount_xof INTEGER NOT NULL CHECK (amount_xof > 0),
  external_reference TEXT,
  cash_session_id TEXT REFERENCES cash_sessions(id) ON DELETE RESTRICT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  sync_version INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS payment_allocations (
  id TEXT PRIMARY KEY,
  payment_id TEXT NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
  target_type TEXT NOT NULL CHECK (target_type IN ('SALE', 'PURCHASE_ORDER', 'CONSIGNMENT_REFUND')),
  target_id TEXT NOT NULL,
  allocated_xof INTEGER NOT NULL CHECK (allocated_xof > 0)
);

-- MODULE 8 : Consignes & Emballages
CREATE TABLE IF NOT EXISTS consignment_balances (
  id TEXT PRIMARY KEY,
  holder_type TEXT NOT NULL CHECK (holder_type IN ('DEPOT', 'CUSTOMER', 'SUPPLIER')),
  holder_id TEXT NOT NULL,
  packaging_type_id TEXT NOT NULL REFERENCES packaging_types(id) ON DELETE RESTRICT,
  quantity INTEGER NOT NULL DEFAULT 0,
  deposit_value_xof INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (holder_type, holder_id, packaging_type_id)
);

CREATE TABLE IF NOT EXISTS consignment_movements (
  id TEXT PRIMARY KEY,
  packaging_type_id TEXT NOT NULL REFERENCES packaging_types(id) ON DELETE RESTRICT,
  movement_type TEXT NOT NULL CHECK (movement_type IN (
    'SALE_DEPOSIT', 'CUSTOMER_RETURN', 'REFUND', 'EXCHANGE',
    'SUPPLIER_DEPOSIT', 'SUPPLIER_RETURN', 'BREAKAGE', 'LOSS'
  )),
  holder_type TEXT NOT NULL CHECK (holder_type IN ('DEPOT', 'CUSTOMER', 'SUPPLIER')),
  holder_id TEXT NOT NULL,
  quantity_delta INTEGER NOT NULL CHECK (quantity_delta != 0),
  amount_xof INTEGER NOT NULL DEFAULT 0 CHECK (amount_xof >= 0),
  reference_type TEXT,
  reference_id TEXT,
  note TEXT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  sync_version INTEGER NOT NULL DEFAULT 1
);

-- MODULE 9 & 10 : Caisse, Dépenses
CREATE TABLE IF NOT EXISTS cash_movements (
  id TEXT PRIMARY KEY,
  cash_session_id TEXT NOT NULL REFERENCES cash_sessions(id) ON DELETE RESTRICT,
  movement_type TEXT NOT NULL CHECK (movement_type IN (
    'OPENING', 'SALE_CASH', 'DEBT_COLLECTION', 'EXPENSE',
    'SUPPLIER_PAYMENT', 'CONSIGNMENT_REFUND', 'MANUAL_IN', 'MANUAL_OUT', 'CLOSING_ADJUSTMENT'
  )),
  amount_signed_xof INTEGER NOT NULL,
  reference_type TEXT,
  reference_id TEXT,
  description TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS expense_categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT
);

CREATE TABLE IF NOT EXISTS expenses (
  id TEXT PRIMARY KEY,
  category_id TEXT NOT NULL REFERENCES expense_categories(id) ON DELETE RESTRICT,
  amount_xof INTEGER NOT NULL CHECK (amount_xof > 0),
  payment_method TEXT NOT NULL CHECK (payment_method IN ('CASH', 'ORANGE_MONEY', 'MTN_MOMO', 'MOOV_MONEY', 'WAVE', 'BANK_TRANSFER')),
  cash_session_id TEXT REFERENCES cash_sessions(id) ON DELETE RESTRICT,
  receipt_reference TEXT,
  description TEXT NOT NULL,
  expense_date TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  sync_version INTEGER NOT NULL DEFAULT 1
);

-- MODULE 11 & 9 : Audit & Sauvegardes
CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  payload_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS backup_history (
  id TEXT PRIMARY KEY,
  backup_type TEXT NOT NULL CHECK (backup_type IN ('MANUAL', 'AUTO', 'USB_EXPORT', 'PRE_RESTORE')),
  file_path TEXT NOT NULL,
  file_size_bytes INTEGER NOT NULL CHECK (file_size_bytes >= 0),
  sha256_checksum TEXT NOT NULL,
  integrity_status TEXT NOT NULL CHECK (integrity_status IN ('VERIFIED', 'FAILED')),
  created_by_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Index de performance pour recherches et rapports
CREATE INDEX IF NOT EXISTS idx_products_name ON products(name);
CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode);
CREATE INDEX IF NOT EXISTS idx_stock_movements_product_date ON stock_movements(product_id, created_at);
CREATE INDEX IF NOT EXISTS idx_sales_created_at ON sales(created_at);
CREATE INDEX IF NOT EXISTS idx_sales_customer ON sales(customer_id);
CREATE INDEX IF NOT EXISTS idx_payments_party ON payments(party_type, party_id);
CREATE INDEX IF NOT EXISTS idx_consignment_movements_holder ON consignment_movements(holder_type, holder_id, created_at);
CREATE INDEX IF NOT EXISTS idx_cash_movements_session ON cash_movements(cash_session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at);
