-- DepotPro CI — Migration 0003: Sessions locales et paramètres étendus du dépôt (LOT 1)

CREATE TABLE IF NOT EXISTS user_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_user_sessions_token ON user_sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id);

ALTER TABLE business_settings ADD COLUMN default_cash_float_xof INTEGER NOT NULL DEFAULT 0 CHECK (default_cash_float_xof >= 0);
ALTER TABLE business_settings ADD COLUMN receipt_print_width TEXT NOT NULL DEFAULT '80mm' CHECK (receipt_print_width IN ('58mm', '80mm'));

UPDATE system_meta
SET value = 'LOT_1',
    description = 'Lot courant : Authentification, RBAC et Configuration initiale du dépôt.',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE key = 'app.lot_current';
