import { z } from 'zod';

export const cancelSaleSchema = z.object({
  reason: z.string().trim().min(3, 'Saisissez un motif d’annulation (min. 3 caractères)').max(240),
});

export type CancelSaleFormValues = z.infer<typeof cancelSaleSchema>;
