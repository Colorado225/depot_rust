import { invoke as tauriInvoke, isTauri } from '@tauri-apps/api/core';
import { AppErrorPayload, ClientAppError } from '../types/errors';
import type { BackupHistoryEntry } from '../types/backup';
import { RUST_COMMAND_SET, RUST_PARITY } from './rustCommands.generated';

const SESSION_TOKEN_STORAGE_KEY = 'depotpro_session_token';

export function getStoredSessionToken(): string | null {
  if (typeof window === 'undefined') return null;
  return window.sessionStorage.getItem(SESSION_TOKEN_STORAGE_KEY);
}

export function setStoredSessionToken(token: string | null): void {
  if (typeof window === 'undefined') return;
  if (token) {
    window.sessionStorage.setItem(SESSION_TOKEN_STORAGE_KEY, token);
  } else {
    window.sessionStorage.removeItem(SESSION_TOKEN_STORAGE_KEY);
  }
}

/** Détection officielle Tauri 2 (flag injecté par la coquille, pas par le web). */
export function isTauriDesktop(): boolean {
  return isTauri();
}

/**
 * LOT 10 — 95/95 : le desktop n'utilise PLUS d'origine HTTP locale.
 *
 * `COMMAND_HTTP_MAP` et les trois helpers de fichiers gardent un chemin HTTP
 * relatif UNIQUEMENT pour le navigateur / preview web (Express + Vite), qui
 * reste la référence fonctionnelle. En Tauri, `invokeBackend` appelle toujours
 * une commande Rust et les fichiers passent par `invokeRustService`.
 */
export async function getBackendOrigin(): Promise<string> {
  return '';
}

/** Conservé pour la compatibilité des tests de transport (plus de cache). */
export function resetBackendOriginCache(): void {
  // Aucun état : l'origine desktop est définitivement vide.
}

interface HttpMapping {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string | ((payload?: Record<string, unknown>) => string);
  omitKeysFromBody?: string[];
}

const COMMAND_HTTP_MAP: Record<string, HttpMapping> = {
  // LOT 0 System
  check_system_health: { method: 'GET', url: '/api/system/health' },
  get_migrations_status: { method: 'GET', url: '/api/system/migrations' },
  get_architectural_decisions: { method: 'GET', url: '/api/system/decisions' },
  get_license_state: { method: 'GET', url: '/api/system/license' },
  update_local_license: { method: 'POST', url: '/api/system/license/activate' },
  reset_local_license: { method: 'POST', url: '/api/system/license/reset-trial' },
  trigger_integrity_check: { method: 'POST', url: '/api/system/integrity-check' },
  run_foundation_self_test: { method: 'POST', url: '/api/system/self-test' },

  // LOT 1 Auth & RBAC
  auth_bootstrap_status: { method: 'GET', url: '/api/auth/bootstrap-status' },
  auth_initialize_depot: { method: 'POST', url: '/api/auth/setup' },
  auth_login: { method: 'POST', url: '/api/auth/login' },
  auth_logout: { method: 'POST', url: '/api/auth/logout' },
  auth_me: { method: 'GET', url: '/api/auth/me' },
  auth_change_password: { method: 'POST', url: '/api/auth/change-password' },
  auth_list_users: { method: 'GET', url: '/api/auth/users' },
  auth_create_user: { method: 'POST', url: '/api/auth/users' },
  auth_toggle_user_status: {
    method: 'PATCH',
    url: (p) => `/api/auth/users/${String(p?.userId)}/status`,
    omitKeysFromBody: ['userId'],
  },
  auth_unlock_user: {
    method: 'POST',
    url: (p) => `/api/auth/users/${String(p?.userId)}/unlock`,
    omitKeysFromBody: ['userId'],
  },
  auth_update_user_role: {
    method: 'PATCH',
    url: (p) => `/api/auth/users/${String(p?.userId)}/role`,
    omitKeysFromBody: ['userId'],
  },
  auth_list_roles: { method: 'GET', url: '/api/auth/roles' },
  auth_list_login_logs: { method: 'GET', url: '/api/auth/login-logs' },

  // LOT 1 Depot Settings
  settings_get: { method: 'GET', url: '/api/settings' },
  settings_update: { method: 'PUT', url: '/api/settings' },

  // LOT 2 Catalogue
  catalog_list_categories: { method: 'GET', url: '/api/catalog/categories' },
  catalog_create_category: { method: 'POST', url: '/api/catalog/categories' },
  catalog_list_brands: { method: 'GET', url: '/api/catalog/brands' },
  catalog_create_brand: { method: 'POST', url: '/api/catalog/brands' },
  catalog_list_units: { method: 'GET', url: '/api/catalog/units' },
  catalog_list_packaging: { method: 'GET', url: '/api/catalog/packaging-types' },
  catalog_create_packaging: { method: 'POST', url: '/api/catalog/packaging-types' },
  catalog_update_packaging: {
    method: 'PUT',
    url: (p) => `/api/catalog/packaging-types/${String(p?.id)}`,
    omitKeysFromBody: ['id'],
  },
  catalog_list_products: {
    method: 'GET',
    url: (p) => {
      const params = new URLSearchParams();
      if (typeof p?.search === 'string' && p.search) params.set('search', p.search);
      if (typeof p?.categoryId === 'string' && p.categoryId) params.set('categoryId', p.categoryId);
      if (typeof p?.brandId === 'string' && p.brandId) params.set('brandId', p.brandId);
      if (p?.includeInactive) params.set('includeInactive', 'true');
      const qs = params.toString();
      return qs ? `/api/catalog/products?${qs}` : '/api/catalog/products';
    },
  },
  catalog_create_product: { method: 'POST', url: '/api/catalog/products' },
  catalog_update_product: {
    method: 'PUT',
    url: (p) => `/api/catalog/products/${String(p?.id)}`,
    omitKeysFromBody: ['id'],
  },
  catalog_toggle_product_active: {
    method: 'PATCH',
    url: (p) => `/api/catalog/products/${String(p?.id)}/active`,
    omitKeysFromBody: ['id'],
  },

  // LOT 3 Stock & Mouvements
  stock_list_balances: {
    method: 'GET',
    url: (p) => {
      const params = new URLSearchParams();
      if (typeof p?.search === 'string' && p.search) params.set('search', p.search);
      if (p?.onlyLowStock) params.set('onlyLowStock', 'true');
      const qs = params.toString();
      return qs ? `/api/stock/balances?${qs}` : '/api/stock/balances';
    },
  },
  stock_list_movements: {
    method: 'GET',
    url: (p) => {
      const params = new URLSearchParams();
      if (typeof p?.productId === 'string' && p.productId) params.set('productId', p.productId);
      if (typeof p?.movementType === 'string' && p.movementType)
        params.set('movementType', p.movementType);
      if (typeof p?.limit === 'number') params.set('limit', String(p.limit));
      const qs = params.toString();
      return qs ? `/api/stock/movements?${qs}` : '/api/stock/movements';
    },
  },
  stock_record_movement: { method: 'POST', url: '/api/stock/movements' },
  stock_list_inventories: { method: 'GET', url: '/api/stock/inventories' },
  stock_validate_inventory: { method: 'POST', url: '/api/stock/inventories' },

  // Fournisseurs
  suppliers_list: {
    method: 'GET',
    url: (p) => {
      const params = new URLSearchParams();
      if (typeof p?.search === 'string' && p.search) params.set('search', p.search);
      if (p?.includeInactive) params.set('includeInactive', 'true');
      const qs = params.toString();
      return qs ? `/api/suppliers?${qs}` : '/api/suppliers';
    },
  },
  suppliers_create: { method: 'POST', url: '/api/suppliers' },
  suppliers_update: {
    method: 'PUT',
    url: (p) => `/api/suppliers/${String(p?.id)}`,
    omitKeysFromBody: ['id'],
  },
  suppliers_toggle_active: {
    method: 'PATCH',
    url: (p) => `/api/suppliers/${String(p?.id)}/active`,
    omitKeysFromBody: ['id'],
  },

  // LOT 4 Achats & Réceptions
  purchases_list_orders: {
    method: 'GET',
    url: (p) => {
      const params = new URLSearchParams();
      if (typeof p?.search === 'string' && p.search) params.set('search', p.search);
      if (typeof p?.supplierId === 'string' && p.supplierId)
        params.set('supplierId', p.supplierId);
      if (typeof p?.status === 'string' && p.status) params.set('status', p.status);
      const qs = params.toString();
      return qs ? `/api/purchases/orders?${qs}` : '/api/purchases/orders';
    },
  },
  purchases_create_order: { method: 'POST', url: '/api/purchases/orders' },
  purchases_validate_order: {
    method: 'POST',
    url: (p) => `/api/purchases/orders/${String(p?.id)}/validate`,
    omitKeysFromBody: ['id'],
  },
  purchases_cancel_order: {
    method: 'POST',
    url: (p) => `/api/purchases/orders/${String(p?.id)}/cancel`,
    omitKeysFromBody: ['id'],
  },
  purchases_receive_order: {
    method: 'POST',
    url: (p) => `/api/purchases/orders/${String(p?.id)}/receive`,
    omitKeysFromBody: ['id'],
  },
  purchases_list_receipts: {
    method: 'GET',
    url: (p) => {
      const params = new URLSearchParams();
      if (typeof p?.purchaseOrderId === 'string' && p.purchaseOrderId)
        params.set('purchaseOrderId', p.purchaseOrderId);
      if (typeof p?.supplierId === 'string' && p.supplierId)
        params.set('supplierId', p.supplierId);
      const qs = params.toString();
      return qs ? `/api/purchases/receipts?${qs}` : '/api/purchases/receipts';
    },
  },
  purchases_list_payments: {
    method: 'GET',
    url: (p) => {
      const params = new URLSearchParams();
      if (typeof p?.supplierId === 'string' && p.supplierId)
        params.set('supplierId', p.supplierId);
      if (typeof p?.purchaseOrderId === 'string' && p.purchaseOrderId)
        params.set('purchaseOrderId', p.purchaseOrderId);
      const qs = params.toString();
      return qs ? `/api/purchases/payments?${qs}` : '/api/purchases/payments';
    },
  },
  purchases_record_payment: { method: 'POST', url: '/api/purchases/payments' },
  purchases_record_return: { method: 'POST', url: '/api/purchases/returns' },

  // LOT 5 Clients & Créances
  customers_list: {
    method: 'GET',
    url: (p) => {
      const params = new URLSearchParams();
      if (typeof p?.search === 'string' && p.search) params.set('search', p.search);
      if (typeof p?.customerType === 'string' && p.customerType)
        params.set('customerType', p.customerType);
      if (p?.onlyWithDebt) params.set('onlyWithDebt', 'true');
      if (p?.includeInactive) params.set('includeInactive', 'true');
      const qs = params.toString();
      return qs ? `/api/customers?${qs}` : '/api/customers';
    },
  },
  customers_statement: {
    method: 'GET',
    url: (p) => `/api/customers/${String(p?.id)}/statement`,
  },
  customers_create: { method: 'POST', url: '/api/customers' },
  customers_update: {
    method: 'PUT',
    url: (p) => `/api/customers/${String(p?.id)}`,
    omitKeysFromBody: ['id'],
  },
  customers_toggle_active: {
    method: 'PATCH',
    url: (p) => `/api/customers/${String(p?.id)}/active`,
    omitKeysFromBody: ['id'],
  },
  customers_record_payment: { method: 'POST', url: '/api/customers/payments' },

  // LOT 5 Point de Vente POS & Ventes
  pos_list_sales: {
    method: 'GET',
    url: (p) => {
      const params = new URLSearchParams();
      if (typeof p?.search === 'string' && p.search) params.set('search', p.search);
      if (typeof p?.customerId === 'string' && p.customerId)
        params.set('customerId', p.customerId);
      if (typeof p?.status === 'string' && p.status) params.set('status', p.status);
      if (typeof p?.priceTier === 'string' && p.priceTier)
        params.set('priceTier', p.priceTier);
      if (typeof p?.limit === 'number') params.set('limit', String(p.limit));
      const qs = params.toString();
      return qs ? `/api/pos/sales?${qs}` : '/api/pos/sales';
    },
  },
  pos_create_sale: { method: 'POST', url: '/api/pos/sales' },
  pos_cancel_sale: {
    method: 'POST',
    url: (p) => `/api/pos/sales/${String(p?.id)}/cancel`,
    omitKeysFromBody: ['id'],
  },

  // LOT 6 Consignes & Emballages
  consignments_summary: { method: 'GET', url: '/api/consignments/summary' },
  consignments_balances: {
    method: 'GET',
    url: (p) => {
      const params = new URLSearchParams();
      if (typeof p?.holderType === 'string' && p.holderType)
        params.set('holderType', p.holderType);
      if (typeof p?.holderId === 'string' && p.holderId) params.set('holderId', p.holderId);
      if (typeof p?.kind === 'string' && p.kind) params.set('kind', p.kind);
      if (p?.onlyNonZero) params.set('onlyNonZero', 'true');
      const qs = params.toString();
      return qs ? `/api/consignments/balances?${qs}` : '/api/consignments/balances';
    },
  },
  consignments_movements: {
    method: 'GET',
    url: (p) => {
      const params = new URLSearchParams();
      if (typeof p?.holderType === 'string' && p.holderType)
        params.set('holderType', p.holderType);
      if (typeof p?.packagingTypeId === 'string' && p.packagingTypeId)
        params.set('packagingTypeId', p.packagingTypeId);
      if (typeof p?.movementType === 'string' && p.movementType)
        params.set('movementType', p.movementType);
      if (typeof p?.limit === 'number') params.set('limit', String(p.limit));
      const qs = params.toString();
      return qs ? `/api/consignments/movements?${qs}` : '/api/consignments/movements';
    },
  },
  consignments_customer_return: { method: 'POST', url: '/api/consignments/customer-return' },
  consignments_customer_operation: {
    method: 'POST',
    url: '/api/consignments/customer-operation',
  },
  consignments_supplier_operation: {
    method: 'POST',
    url: '/api/consignments/supplier-operation',
  },
  consignments_depot_operation: { method: 'POST', url: '/api/consignments/depot-operation' },

  // LOT 7 Finances & Caisse
  finance_overview: { method: 'GET', url: '/api/finance/overview' },
  finance_list_registers: { method: 'GET', url: '/api/finance/registers' },
  finance_list_sessions: {
    method: 'GET',
    url: (p) =>
      typeof p?.limit === 'number' ? `/api/finance/sessions?limit=${p.limit}` : '/api/finance/sessions',
  },
  finance_session_detail: {
    method: 'GET',
    url: (p) => `/api/finance/sessions/${String(p?.id)}`,
  },
  finance_open_session: { method: 'POST', url: '/api/finance/sessions/open' },
  finance_manual_movement: {
    method: 'POST',
    url: (p) => `/api/finance/sessions/${String(p?.cashSessionId)}/manual-movement`,
    omitKeysFromBody: ['cashSessionId'],
  },
  finance_close_session: {
    method: 'POST',
    url: (p) => `/api/finance/sessions/${String(p?.id)}/close`,
    omitKeysFromBody: ['id'],
  },
  finance_override_session: {
    method: 'POST',
    url: (p) => `/api/finance/sessions/${String(p?.id)}/override`,
    omitKeysFromBody: ['id'],
  },
  finance_list_expense_categories: { method: 'GET', url: '/api/finance/expense-categories' },
  finance_create_expense_category: { method: 'POST', url: '/api/finance/expense-categories' },
  finance_list_expenses: {
    method: 'GET',
    url: (p) => {
      const params = new URLSearchParams();
      if (typeof p?.categoryId === 'string' && p.categoryId)
        params.set('categoryId', p.categoryId);
      if (typeof p?.paymentMethod === 'string' && p.paymentMethod)
        params.set('paymentMethod', p.paymentMethod);
      if (typeof p?.limit === 'number') params.set('limit', String(p.limit));
      const qs = params.toString();
      return qs ? `/api/finance/expenses?${qs}` : '/api/finance/expenses';
    },
  },
  finance_record_expense: { method: 'POST', url: '/api/finance/expenses' },
  finance_list_payments: {
    method: 'GET',
    url: (p) => {
      const params = new URLSearchParams();
      if (typeof p?.paymentMethod === 'string' && p.paymentMethod)
        params.set('paymentMethod', p.paymentMethod);
      if (typeof p?.direction === 'string' && p.direction)
        params.set('direction', p.direction);
      if (typeof p?.limit === 'number') params.set('limit', String(p.limit));
      const qs = params.toString();
      return qs ? `/api/finance/payments?${qs}` : '/api/finance/payments';
    },
  },

  // LOT 8 Rapports & Exports
  reports_overview: {
    method: 'GET',
    url: (p) => {
      const params = new URLSearchParams();
      if (typeof p?.startDate === 'string' && p.startDate) params.set('startDate', p.startDate);
      if (typeof p?.endDate === 'string' && p.endDate) params.set('endDate', p.endDate);
      const qs = params.toString();
      return qs ? `/api/reports/overview?${qs}` : '/api/reports/overview';
    },
  },
  reports_product_margins: {
    method: 'GET',
    url: (p) => {
      const params = new URLSearchParams();
      if (typeof p?.startDate === 'string' && p.startDate) params.set('startDate', p.startDate);
      if (typeof p?.endDate === 'string' && p.endDate) params.set('endDate', p.endDate);
      const qs = params.toString();
      return qs ? `/api/reports/product-margins?${qs}` : '/api/reports/product-margins';
    },
  },
  reports_snapshot: { method: 'GET', url: '/api/reports/snapshot' },
  reports_daily: {
    method: 'GET',
    url: (p) => {
      const params = new URLSearchParams();
      if (typeof p?.startDate === 'string' && p.startDate) params.set('startDate', p.startDate);
      if (typeof p?.endDate === 'string' && p.endDate) params.set('endDate', p.endDate);
      const qs = params.toString();
      return qs ? `/api/reports/daily?${qs}` : '/api/reports/daily';
    },
  },

  // LOT 9 Sauvegardes, Restauration & Fiabilisation
  backup_overview: { method: 'GET', url: '/api/system/backups/overview' },
  backup_config_update: { method: 'PUT', url: '/api/system/backups/config' },
  backup_create: { method: 'POST', url: '/api/system/backups' },
  backup_auto_run: { method: 'POST', url: '/api/system/backups/auto/run' },
  backup_diagnostics: { method: 'GET', url: '/api/system/backups/diagnostics' },
  backup_self_test: { method: 'POST', url: '/api/system/backups/self-test' },
  backup_cancel_restore: { method: 'DELETE', url: '/api/system/backups/restore/pending' },
  backup_verify: {
    method: 'POST',
    url: (p) => `/api/system/backups/${String(p?.id)}/verify`,
    omitKeysFromBody: ['id'],
  },
  backup_restore: {
    method: 'POST',
    url: (p) => `/api/system/backups/${String(p?.id)}/restore`,
    omitKeysFromBody: ['id'],
  },
};

/** Appelle une commande de service Rust (fichiers binaires, diagnostic). */
async function invokeRustService<T>(
  command: string,
  payload: Record<string, unknown>
): Promise<T> {
  const token = getStoredSessionToken();
  const input: Record<string, unknown> = { ...payload };
  if (token) input.token = token;
  try {
    return await tauriInvoke<T>(command, { input });
  } catch (rawErr) {
    throw parseRustError(rawErr);
  }
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function bytesToBlob(bytes: Uint8Array, mimeType: string): Blob {
  return new Blob([bytes.buffer as ArrayBuffer], { type: mimeType });
}

function saveBlob(blob: Blob, filename: string): void {
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(objectUrl);
}

async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export async function downloadReportExport(opts: {
  format: 'csv' | 'pdf';
  dataset: string;
  startDate?: string;
  endDate?: string;
}): Promise<string> {
  if (isTauriDesktop()) {
    const payload: Record<string, unknown> = { format: opts.format, dataset: opts.dataset };
    if (opts.startDate) payload.startDate = opts.startDate;
    if (opts.endDate) payload.endDate = opts.endDate;
    const file = await invokeRustService<{
      filename: string;
      mimeType: string;
      contentBase64: string;
    }>('reports_export_file', payload);
    saveBlob(bytesToBlob(base64ToBytes(file.contentBase64), file.mimeType), file.filename);
    return file.filename;
  }

  const token = getStoredSessionToken();
  const params = new URLSearchParams({ dataset: opts.dataset });
  if (opts.startDate) params.set('startDate', opts.startDate);
  if (opts.endDate) params.set('endDate', opts.endDate);

  const origin = await getBackendOrigin();
  const response = await fetch(`${origin}/api/reports/export/${opts.format}?${params.toString()}`, {
    method: 'GET',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });

  if (!response.ok) {
    const errBody = await response.json().catch(() => null);
    throw new ClientAppError(
      errBody && typeof errBody === 'object' && 'code' in errBody && 'message' in errBody
        ? (errBody as AppErrorPayload)
        : { code: 'INTERNAL_ERROR', message: `Échec d'export HTTP ${response.status}` }
    );
  }

  const blob = await response.blob();
  const disposition = response.headers.get('content-disposition') ?? '';
  const match = disposition.match(/filename="([^"]+)"/);
  const filename = match?.[1] ?? `depotpro-${opts.dataset}.${opts.format}`;
  saveBlob(blob, filename);
  return filename;
}

/** LOT 9 — Télécharge une sauvegarde .db vérifiée (Tauri IPC ou preview web). */
export async function downloadBackupFile(backupId: string): Promise<string> {
  if (isTauriDesktop()) {
    const file = await invokeRustService<{
      fileName: string;
      mimeType: string;
      contentBase64: string;
    }>('backup_download_file', { id: backupId });
    saveBlob(bytesToBlob(base64ToBytes(file.contentBase64), file.mimeType), file.fileName);
    return file.fileName;
  }

  const token = getStoredSessionToken();
  const origin = await getBackendOrigin();
  const response = await fetch(`${origin}/api/system/backups/${encodeURIComponent(backupId)}/download`, {
    method: 'GET',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });

  if (!response.ok) {
    const errBody = await response.json().catch(() => null);
    throw new ClientAppError(
      errBody && typeof errBody === 'object' && 'code' in errBody && 'message' in errBody
        ? (errBody as AppErrorPayload)
        : { code: 'INTERNAL_ERROR', message: `Échec du téléchargement HTTP ${response.status}` }
    );
  }

  const blob = await response.blob();
  const disposition = response.headers.get('content-disposition') ?? '';
  const match = disposition.match(/filename="([^"]+)"/);
  const filename = match?.[1] ?? `depotpro-sauvegarde-${backupId}.db`;
  saveBlob(blob, filename);
  return filename;
}

/**
 * LOT 9 — Importe un fichier .db depuis une clé USB / un autre poste.
 * En Tauri, les octets sont transmis en base64 à la commande Rust ; le
 * SHA-256 calculé dans la webview est revérifié côté Rust avant écriture.
 */
export async function importBackupFile(file: File): Promise<BackupHistoryEntry> {
  if (isTauriDesktop()) {
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let sourceChecksum: string | undefined;
    try {
      if (globalThis.crypto?.subtle) sourceChecksum = await sha256Hex(buffer);
    } catch {
      // Environnement sans WebCrypto : Rust revérifie seul l'intégrité.
    }
    const payload: Record<string, unknown> = {
      originalName: file.name,
      contentBase64: bytesToBase64(bytes),
    };
    if (sourceChecksum) payload.sourceChecksum = sourceChecksum;
    return invokeRustService<BackupHistoryEntry>('backup_import_file', payload);
  }

  const token = getStoredSessionToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/octet-stream',
    // Les en-têtes HTTP doivent rester en caractères latin1.
    'X-DepotPro-Filename': file.name.replace(/[^\x20-\x7e]/g, '_').slice(0, 120),
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  try {
    if (globalThis.crypto?.subtle) {
      const hex = await sha256Hex(await file.arrayBuffer());
      headers['X-DepotPro-Source-Checksum'] = hex;
    }
  } catch {
    // Environnement sans WebCrypto : le backend revérifie seul l'intégrité.
  }

  const origin = await getBackendOrigin();
  const response = await fetch(`${origin}/api/system/backups/import`, {
    method: 'POST',
    headers,
    body: file,
  });

  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ClientAppError(
      data && typeof data === 'object' && 'code' in data && 'message' in data
        ? (data as AppErrorPayload)
        : { code: 'INTERNAL_ERROR', message: `Échec de l'import HTTP ${response.status}` }
    );
  }
  return data as BackupHistoryEntry;
}

export type RustParityMode = 'transitional' | 'strict';
let rustParityMode: RustParityMode = 'strict';

/** Mode strict (défaut) = aucun repli HTTP n'est toléré en Tauri. */
export function setRustParityMode(mode: RustParityMode): void {
  rustParityMode = mode;
}

export function getRustParityMode(): RustParityMode {
  return rustParityMode;
}

/** Avancement du port, affichable dans les diagnostics de livraison. */
export function getRustParity(): { total: number; implemented: number; complete: boolean } {
  return { ...RUST_PARITY };
}

/** Convertit une erreur renvoyée par un handler Rust en ClientAppError. */
function parseRustError(rawErr: unknown): ClientAppError {
  if (typeof rawErr === 'string') {
    try {
      const parsed = JSON.parse(rawErr) as AppErrorPayload;
      if (parsed?.code && parsed?.message) {
        return new ClientAppError(parsed);
      }
    } catch {
      // Message Rust non structuré : on le transmet tel quel.
    }
    return new ClientAppError({ code: 'INTERNAL_ERROR', message: rawErr });
  }
  if (rawErr && typeof rawErr === 'object' && 'code' in rawErr && 'message' in rawErr) {
    return new ClientAppError(rawErr as AppErrorPayload);
  }
  return new ClientAppError({
    code: 'INTERNAL_ERROR',
    message: rawErr instanceof Error ? rawErr.message : String(rawErr),
  });
}

export async function invokeBackend<T>(
  command: string,
  payload?: Record<string, unknown>
): Promise<T> {
  const token = getStoredSessionToken();

  // LOT 10 — Architecture cible : la logique critique est exécutée en Rust.
  // Le payload est transmis tel quel (camelCase) dans l'argument `input`,
  // avec le jeton de session que les services Rust vérifient avant toute
  // lecture ou écriture métier.
  if (isTauriDesktop() && RUST_COMMAND_SET.has(command)) {
    const input: Record<string, unknown> = { ...(payload ?? {}) };
    if (token) input.token = token;
    try {
      return await tauriInvoke<T>(command, { input });
    } catch (rawErr) {
      throw parseRustError(rawErr);
    }
  }

  // LOT 10 — 95/95 : le pont HTTP local est retiré de la coquille Tauri.
  // Aucun mode « transitional » ne peut le réactiver ; le chemin HTTP ci-dessous
  // est réservé au navigateur / preview web de référence.
  if (isTauriDesktop()) {
    throw new ClientAppError({
      code: 'NOT_IMPLEMENTED_IN_RUST',
      message: `Commande « ${command} » absente du registre Rust (${RUST_PARITY.implemented}/${RUST_PARITY.total}). Le pont HTTP desktop a été retiré.`,
    });
  }

  const mapping = COMMAND_HTTP_MAP[command];
  if (!mapping) {
    throw new ClientAppError({
      code: 'NOT_FOUND',
      message: `Commande backend inconnue : ${command}`,
    });
  }

  const targetUrl = typeof mapping.url === 'function' ? mapping.url(payload) : mapping.url;
  const origin = await getBackendOrigin();
  const headers: Record<string, string> = {};
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  let body: string | undefined;
  if (mapping.method !== 'GET') {
    headers['Content-Type'] = 'application/json';
    const cleanBody: Record<string, unknown> = { ...(payload ?? {}) };
    if (mapping.omitKeysFromBody) {
      for (const k of mapping.omitKeysFromBody) {
        delete cleanBody[k];
      }
    }
    body = JSON.stringify(cleanBody);
  }

  const response = await fetch(`${origin}${targetUrl}`, {
    method: mapping.method,
    headers,
    body,
  });

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    const errPayload: AppErrorPayload =
      data && typeof data === 'object' && 'code' in data && 'message' in data
        ? (data as AppErrorPayload)
        : {
            code: 'INTERNAL_ERROR',
            message: `Erreur HTTP ${response.status} lors de l'appel ${command}`,
          };
    throw new ClientAppError(errPayload);
  }

  return data as T;
}
