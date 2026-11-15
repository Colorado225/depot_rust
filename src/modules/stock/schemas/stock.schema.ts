import { z } from 'zod';

export const stockMovementFormSchema = z.object({
  productId: z.string().min(1, 'Sélectionnez un produit'),
  unitId: z.string().min(1, 'Sélectionnez une unité'),
  movementType: z.enum(['INITIAL', 'MANUAL_IN', 'MANUAL_OUT', 'BREAKAGE', 'LOSS']),
  quantity: z.coerce
    .number()
    .int('Quantité entière requise')
    .min(1, 'La quantité doit être au moins 1'),
  unitCostXof: z.coerce
    .number()
    .int('Montant entier FCFA requis')
    .min(0, 'Le coût ne peut pas être négatif')
    .optional(),
  note: z.string().trim().max(240).optional().or(z.literal('')),
});

export type StockMovementFormValues = z.infer<typeof stockMovementFormSchema>;
