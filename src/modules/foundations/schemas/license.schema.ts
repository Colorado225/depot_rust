import { z } from 'zod';

export const activateLicenseSchema = z.object({
  licenseKey: z
    .string()
    .trim()
    .regex(/^DPCI-[A-Za-z0-9]{4}-[A-Za-z0-9]{4}$/, 'Format attendu : DPCI-XXXX-XXXX'),
  depotNameBound: z
    .string()
    .trim()
    .min(2, 'Le nom du dépôt doit contenir au moins 2 caractères')
    .max(120, 'Maximum 120 caractères'),
});

export type ActivateLicenseFormValues = z.infer<typeof activateLicenseSchema>;
