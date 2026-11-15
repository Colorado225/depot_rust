import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { AppError } from '../error.ts';
import { assertNonNegativeXof } from '../domain/money.ts';

export interface BusinessSettingsDTO {
  id: string;
  depotName: string;
  ownerName: string;
  phone: string | null;
  address: string | null;
  logoPath: string | null;
  currency: 'XOF';
  receiptHeader: string | null;
  receiptFooter: string | null;
  defaultConsignmentPolicy: string;
  allowNegativeStock: boolean;
  defaultCashFloatXof: number;
  receiptPrintWidth: '58mm' | '80mm';
  isInitialized: boolean;
  updatedAt: string;
}

export interface UpdateBusinessSettingsInput {
  depotName: string;
  ownerName: string;
  phone?: string | null;
  address?: string | null;
  logoPath?: string | null;
  receiptHeader?: string | null;
  receiptFooter?: string | null;
  defaultConsignmentPolicy: string;
  allowNegativeStock: boolean;
  defaultCashFloatXof: number;
  receiptPrintWidth: '58mm' | '80mm';
}

export class SettingsRepository {
  constructor(private readonly db: DatabaseSync) {}

  getSettings(): BusinessSettingsDTO {
    const row = this.db
      .prepare(
        `SELECT id, depot_name AS depotName, owner_name AS ownerName,
                phone, address, logo_path AS logoPath, currency,
                receipt_header AS receiptHeader, receipt_footer AS receiptFooter,
                default_consignment_policy AS defaultConsignmentPolicy,
                allow_negative_stock AS allowNegativeStock,
                default_cash_float_xof AS defaultCashFloatXof,
                receipt_print_width AS receiptPrintWidth,
                is_initialized AS isInitialized,
                updated_at AS updatedAt
         FROM business_settings LIMIT 1`
      )
      .get() as
      | (Omit<BusinessSettingsDTO, 'allowNegativeStock' | 'isInitialized'> & {
          allowNegativeStock: number;
          isInitialized: number;
        })
      | undefined;

    if (!row) {
      throw new AppError('NOT_FOUND', 'Le dépôt n’est pas encore configuré.', 404);
    }

    return {
      ...row,
      allowNegativeStock: row.allowNegativeStock === 1,
      isInitialized: row.isInitialized === 1,
    };
  }

  updateSettings(actorUserId: string, input: UpdateBusinessSettingsInput): BusinessSettingsDTO {
    const floatXof = assertNonNegativeXof(input.defaultCashFloatXof, 'Fonds de caisse initial');

    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const existing = this.db.prepare('SELECT id FROM business_settings LIMIT 1').get() as
        | { id: string }
        | undefined;
      if (!existing) {
        throw new AppError('NOT_FOUND', 'Configuration introuvable. Veuillez initialiser le dépôt.', 404);
      }

      this.db
        .prepare(
          `UPDATE business_settings
           SET depot_name = ?,
               owner_name = ?,
               phone = ?,
               address = ?,
               logo_path = ?,
               receipt_header = ?,
               receipt_footer = ?,
               default_consignment_policy = ?,
               allow_negative_stock = ?,
               default_cash_float_xof = ?,
               receipt_print_width = ?,
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
               sync_version = sync_version + 1
           WHERE id = ?`
        )
        .run(
          input.depotName.trim(),
          input.ownerName.trim(),
          input.phone?.trim() || null,
          input.address?.trim() || null,
          input.logoPath ?? null,
          input.receiptHeader?.trim() || null,
          input.receiptFooter?.trim() || null,
          input.defaultConsignmentPolicy,
          input.allowNegativeStock ? 1 : 0,
          floatXof,
          input.receiptPrintWidth,
          existing.id
        );

      this.db
        .prepare(
          `INSERT INTO audit_logs (id, user_id, action, entity_type, entity_id, payload_json)
           VALUES (?, ?, 'DEPOT_SETTINGS_UPDATED', 'business_settings', ?, ?)`
        )
        .run(
          crypto.randomUUID(),
          actorUserId,
          existing.id,
          JSON.stringify({ depotName: input.depotName.trim(), allowNegativeStock: input.allowNegativeStock })
        );

      this.db.exec('COMMIT;');
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw err;
    }

    return this.getSettings();
  }
}
