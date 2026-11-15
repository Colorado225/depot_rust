import { z } from 'zod';

export const customerFormSchema = z.object({
  fullName: z.string().trim().min(2, 'Nom complet / Raison sociale requis (min. 2 caractères)').max(140),
  customerType: z.enum(['PARTICULIER', 'DETAILLANT', 'REVENDEUR', 'ENTREPRISE']),
  phone: z.string().trim().max(40).optional().or(z.literal('')),
  email: z.string().trim().max(120).optional().or(z.literal('')),
  address: z.string().trim().max(240).optional().or(z.literal('')),
  creditLimitXof: z.coerce.number().int('Plafond entier FCFA requis').min(0, 'Montant >= 0 requis'),
  dueDays: z.coerce.number().int('Nombre entier requis').min(0).max(365),
  notes: z.string().trim().max(300).optional().or(z.literal('')),
});

export type CustomerFormValues = z.infer<typeof customerFormSchema>;

export const customerPaymentFormSchema = z.object({
  customerId: z.string().min(1, 'Client requis'),
  saleId: z.string().optional().or(z.literal('')),
  paymentMethod: z.enum([
    'CASH',
    'ORANGE_MONEY',
    'MTN_MOMO',
    'MOOV_MONEY',
    'WAVE',
    'BANK_TRANSFER',
  ]),
  amountXof: z.coerce.number().int('Montant entier FCFA requis').min(1, 'Montant >= 1 FCFA'),
  externalReference: z.string().trim().max(100).optional().or(z.literal('')),
});

export type CustomerPaymentFormValues = z.infer<typeof customerPaymentFormSchema>;
