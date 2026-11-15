import { z } from 'zod';

export const categoryFormSchema = z.object({
  name: z.string().trim().min(2, 'Minimum 2 caractères').max(80),
  description: z.string().trim().max(240).optional().or(z.literal('')),
});

export type CategoryFormValues = z.infer<typeof categoryFormSchema>;

export const brandFormSchema = z.object({
  name: z.string().trim().min(2, 'Minimum 2 caractères').max(80),
});

export type BrandFormValues = z.infer<typeof brandFormSchema>;

export const packagingTypeFormSchema = z.object({
  code: z
    .string()
    .trim()
    .min(2, 'Code requis (min. 2 caractères)')
    .max(30)
    .regex(/^[A-Za-z0-9_-]+$/, 'Lettres, chiffres, _ ou - uniquement'),
  name: z.string().trim().min(2, 'Désignation requise').max(100),
  kind: z.enum(['BOTTLE', 'CRATE', 'OTHER']),
  depositAmountXof: z.coerce
    .number()
    .int('Montant entier en FCFA requis')
    .min(0, 'Montant positif ou nul requis'),
});

export type PackagingTypeFormValues = z.infer<typeof packagingTypeFormSchema>;

export const productUnitFormSchema = z.object({
  unitId: z.string().min(1, 'Unité requise'),
  conversionToBase: z.coerce
    .number()
    .int('Entier requis')
    .min(1, 'Minimum 1 unité de base'),
  wholesalePriceXof: z.coerce.number().int('Entier FCFA requis').min(0),
  retailPriceXof: z.coerce.number().int('Entier FCFA requis').min(0),
  barcode: z.string().trim().max(64).nullable().optional().or(z.literal('')),
  isDefaultSaleUnit: z.boolean(),
});

export const productFormSchema = z.object({
  sku: z.string().trim().min(2, 'Référence SKU requise').max(64),
  barcode: z.string().trim().max(64).nullable().optional().or(z.literal('')),
  name: z.string().trim().min(2, 'Nom du produit requis').max(160),
  categoryId: z.string().nullable().optional().or(z.literal('')),
  brandId: z.string().nullable().optional().or(z.literal('')),
  preferredSupplierId: z.string().nullable().optional().or(z.literal('')),
  formatLabel: z.string().trim().max(60).nullable().optional().or(z.literal('')),
  baseUnitId: z.string().min(1, 'Unité de base requise'),
  bottlePackagingTypeId: z.string().nullable().optional().or(z.literal('')),
  cratePackagingTypeId: z.string().nullable().optional().or(z.literal('')),
  purchasePriceXof: z.coerce.number().int('Entier FCFA requis').min(0),
  wholesalePriceXof: z.coerce.number().int('Entier FCFA requis').min(0),
  retailPriceXof: z.coerce.number().int('Entier FCFA requis').min(0),
  alertThresholdBase: z.coerce.number().int('Entier requis').min(0),
  units: z.array(productUnitFormSchema).min(1, 'Au moins une unité de vente est requise'),
});

export type ProductFormValues = z.infer<typeof productFormSchema>;
