import { z } from 'zod';

export const businessSettingsSchema = z.object({
  depotName: z.string().trim().min(2, 'Nom du dépôt requis').max(120),
  ownerName: z.string().trim().min(2, 'Nom du propriétaire requis').max(120),
  phone: z.string().trim().max(40).nullable().optional(),
  address: z.string().trim().max(240).nullable().optional(),
  logoPath: z.string().max(700_000).nullable().optional(),
  receiptHeader: z.string().trim().max(240).nullable().optional(),
  receiptFooter: z.string().trim().max(240).nullable().optional(),
  defaultConsignmentPolicy: z.enum(['SEPARATE_TRACKING', 'AUTO_INCLUDE_CRATES']),
  allowNegativeStock: z.boolean(),
  defaultCashFloatXof: z.coerce
    .number()
    .int('Le fonds de caisse doit être un entier en FCFA')
    .min(0, 'Montant positif ou nul requis'),
  receiptPrintWidth: z.enum(['58mm', '80mm']),
});

export type BusinessSettingsFormValues = z.infer<typeof businessSettingsSchema>;
