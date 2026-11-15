import { z } from 'zod';

export const setupDepotSchema = z
  .object({
    depotName: z
      .string()
      .trim()
      .min(2, 'Le nom du dépôt doit contenir au moins 2 caractères')
      .max(120),
    ownerFullName: z
      .string()
      .trim()
      .min(2, 'Le nom complet du propriétaire est requis')
      .max(120),
    phone: z.string().trim().max(40).optional().or(z.literal('')),
    address: z.string().trim().max(240).optional().or(z.literal('')),
    logoPath: z.string().max(700_000).optional().or(z.literal('')),
    receiptHeader: z.string().trim().max(240).optional().or(z.literal('')),
    receiptFooter: z.string().trim().max(240).optional().or(z.literal('')),
    defaultCashFloatXof: z.coerce
      .number()
      .int('Le montant doit être un entier en FCFA')
      .min(0, 'Le fonds de caisse doit être positif ou nul'),
    allowNegativeStock: z.boolean(),
    username: z
      .string()
      .trim()
      .min(3, 'Minimum 3 caractères')
      .max(50)
      .regex(/^[a-zA-Z0-9._-]+$/, 'Lettres, chiffres, ., _ ou - uniquement'),
    password: z.string().min(8, 'Minimum 8 caractères').max(128),
    confirmPassword: z.string().min(1, 'Veuillez confirmer le mot de passe'),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: 'Les mots de passe ne correspondent pas',
    path: ['confirmPassword'],
  });

export type SetupDepotFormValues = z.infer<typeof setupDepotSchema>;

export const loginSchema = z.object({
  username: z.string().trim().min(1, 'Identifiant requis'),
  password: z.string().min(1, 'Mot de passe requis'),
});

export type LoginFormValues = z.infer<typeof loginSchema>;

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Mot de passe actuel requis'),
    newPassword: z.string().min(8, 'Minimum 8 caractères').max(128),
    confirmNewPassword: z.string().min(1, 'Confirmation requise'),
  })
  .refine((data) => data.newPassword === data.confirmNewPassword, {
    message: 'Les nouveaux mots de passe ne correspondent pas',
    path: ['confirmNewPassword'],
  });

export type ChangePasswordFormValues = z.infer<typeof changePasswordSchema>;

export const createUserSchema = z.object({
  fullName: z.string().trim().min(2, 'Nom complet requis').max(120),
  phone: z.string().trim().max(40).optional().or(z.literal('')),
  jobTitle: z.string().trim().max(80).optional().or(z.literal('')),
  username: z
    .string()
    .trim()
    .min(3, 'Minimum 3 caractères')
    .max(50)
    .regex(/^[a-zA-Z0-9._-]+$/, 'Lettres, chiffres, ., _ ou - uniquement'),
  password: z.string().min(8, 'Minimum 8 caractères').max(128),
  roleId: z.string().min(1, 'Rôle requis'),
});

export type CreateUserFormValues = z.infer<typeof createUserSchema>;
