import { z } from 'zod';

export const purchaseOrderLineSchema = z.object({
  productId: z.string().min(1, 'Produit requis'),
  unitId: z.string().min(1, 'Unité requise'),
  orderedQty: z.coerce
    .number()
    .int('Quantité entière requise')
    .min(1, 'Minimum 1'),
  unitCostXof: z.coerce
    .number()
    .int('Coût entier FCFA requis')
    .min(0, 'Coût positif ou nul requis'),
});

export const createPurchaseOrderSchema = z.object({
  supplierId: z.string().min(1, 'Sélectionnez un fournisseur'),
  validateImmediately: z.boolean(),
  note: z.string().trim().max(300).optional().or(z.literal('')),
  items: z.array(purchaseOrderLineSchema).min(1, 'Ajoutez au moins une ligne produit'),
});

export type CreatePurchaseOrderValues = z.infer<typeof createPurchaseOrderSchema>;

export const supplierPaymentFormSchema = z.object({
  supplierId: z.string().min(1, 'Fournisseur requis'),
  purchaseOrderId: z.string().optional().or(z.literal('')),
  paymentMethod: z.enum([
    'CASH',
    'ORANGE_MONEY',
    'MTN_MOMO',
    'MOOV_MONEY',
    'WAVE',
    'BANK_TRANSFER',
  ]),
  amountXof: z.coerce
    .number()
    .int('Montant entier FCFA requis')
    .min(1, 'Le montant doit être > 0 FCFA'),
  externalReference: z.string().trim().max(100).optional().or(z.literal('')),
});

export type SupplierPaymentFormValues = z.infer<typeof supplierPaymentFormSchema>;

export const supplierReturnFormSchema = z.object({
  purchaseOrderId: z.string().min(1, 'Commande requise'),
  productId: z.string().min(1, 'Produit requis'),
  unitId: z.string().min(1, 'Unité requise'),
  quantity: z.coerce.number().int('Quantité entière requise').min(1, 'Minimum 1'),
  note: z.string().trim().max(240).optional().or(z.literal('')),
});

export type SupplierReturnFormValues = z.infer<typeof supplierReturnFormSchema>;
