import { AppErrorPayload, ClientAppError } from '../types/errors';

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

declare global {
  interface Window {
    __TAURI_INTERNALS__?: {
      invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
    };
  }
}

export function isTauriDesktop(): boolean {
  return typeof window !== 'undefined' && Boolean(window.__TAURI_INTERNALS__?.invoke);
}

interface HttpMapping {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH';
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
};

export async function downloadReportExport(opts: {
  format: 'csv' | 'pdf';
  dataset: string;
  startDate?: string;
  endDate?: string;
}): Promise<string> {
  const token = getStoredSessionToken();
  const params = new URLSearchParams({ dataset: opts.dataset });
  if (opts.startDate) params.set('startDate', opts.startDate);
  if (opts.endDate) params.set('endDate', opts.endDate);

  const response = await fetch(`/api/reports/export/${opts.format}?${params.toString()}`, {
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

  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(objectUrl);

  return filename;
}

export async function invokeBackend<T>(
  command: string,
  payload?: Record<string, unknown>
): Promise<T> {
  const token = getStoredSessionToken();

  if (isTauriDesktop() && window.__TAURI_INTERNALS__) {
    try {
      return await window.__TAURI_INTERNALS__.invoke<T>(command, {
        ...(payload ?? {}),
        ...(token ? { token } : {}),
      });
    } catch (rawErr) {
      if (typeof rawErr === 'string') {
        try {
          const parsed = JSON.parse(rawErr) as AppErrorPayload;
          if (parsed?.code && parsed?.message) {
            throw new ClientAppError(parsed);
          }
        } catch (inner) {
          if (inner instanceof ClientAppError) throw inner;
        }
      }
      throw new ClientAppError({
        code: 'INTERNAL_ERROR',
        message: rawErr instanceof Error ? rawErr.message : String(rawErr),
      });
    }
  }

  const mapping = COMMAND_HTTP_MAP[command];
  if (!mapping) {
    throw new ClientAppError({
      code: 'NOT_FOUND',
      message: `Commande backend inconnue : ${command}`,
    });
  }

  const targetUrl = typeof mapping.url === 'function' ? mapping.url(payload) : mapping.url;
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

  const response = await fetch(targetUrl, {
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
