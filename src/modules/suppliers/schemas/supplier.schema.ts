import { z } from 'zod';

export const supplierFormSchema = z.object({
  name: z.string().trim().min(2, 'Nom du fournisseur requis (min. 2 caractères)').max(120),
  supplierType: z.enum(['BRASSERIE', 'DISTRIBUTEUR', 'IMPORTATEUR', 'AUTRE']),
  phone: z.string().trim().max(40).nullable().optional().or(z.literal('')),
  email: z.string().trim().max(120).nullable().optional().or(z.literal('')),
  address: z.string().trim().max(240).nullable().optional().or(z.literal('')),
  taxId: z.string().trim().max(60).nullable().optional().or(z.literal('')),
  paymentTermsDays: z.coerce
    .number()
    .int('Nombre entier de jours requis')
    .min(0, 'Minimum 0 jour')
    .max(365, 'Maximum 365 jours'),
  notes: z.string().trim().max(400).nullable().optional().or(z.literal('')),
});

export type SupplierFormValues = z.infer<typeof supplierFormSchema>;
