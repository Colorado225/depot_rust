import { Router } from 'express';
import { z } from 'zod';
import { AppError } from '../error.ts';
import { AuthRepository } from '../repositories/authRepo.ts';
import { CatalogRepository } from '../repositories/catalogRepo.ts';
import {
  type AuthenticatedRequest,
  requireAuth,
  requirePermission,
} from '../security/authMiddleware.ts';

const categorySchema = z.object({
  name: z.string().trim().min(2, 'Nom de catégorie requis (min. 2 caractères)').max(80),
  description: z.string().trim().max(240).nullable().optional(),
});

const brandSchema = z.object({
  name: z.string().trim().min(2, 'Nom de marque requis (min. 2 caractères)').max(80),
});

const packagingTypeSchema = z.object({
  code: z
    .string()
    .trim()
    .min(2, 'Code requis')
    .max(30)
    .regex(/^[A-Za-z0-9_-]+$/, 'Lettres, chiffres, _ ou - uniquement'),
  name: z.string().trim().min(2, 'Désignation requise').max(100),
  kind: z.enum(['BOTTLE', 'CRATE', 'OTHER']),
  depositAmountXof: z.number().int().min(0, 'Montant de consigne positif ou nul requis'),
});

const updatePackagingTypeSchema = packagingTypeSchema.omit({ code: true });

const productUnitSchema = z.object({
  unitId: z.string().trim().min(1, 'Unité requise'),
  conversionToBase: z.number().int().min(1, 'Conversion >= 1 requise'),
  wholesalePriceXof: z.number().int().min(0),
  retailPriceXof: z.number().int().min(0),
  barcode: z.string().trim().max(64).nullable().optional(),
  isDefaultSaleUnit: z.boolean().optional(),
});

const saveProductSchema = z.object({
  sku: z.string().trim().min(2, 'Référence SKU requise').max(64),
  barcode: z.string().trim().max(64).nullable().optional(),
  name: z.string().trim().min(2, 'Désignation du produit requise').max(160),
  categoryId: z.string().trim().nullable().optional(),
  brandId: z.string().trim().nullable().optional(),
  preferredSupplierId: z.string().trim().nullable().optional(),
  formatLabel: z.string().trim().max(60).nullable().optional(),
  baseUnitId: z.string().trim().min(1, 'Unité de base requise'),
  bottlePackagingTypeId: z.string().trim().nullable().optional(),
  cratePackagingTypeId: z.string().trim().nullable().optional(),
  purchasePriceXof: z.number().int().min(0),
  wholesalePriceXof: z.number().int().min(0),
  retailPriceXof: z.number().int().min(0),
  alertThresholdBase: z.number().int().min(0),
  units: z.array(productUnitSchema).min(1, 'Au moins une unité de vente est requise'),
});

const toggleActiveSchema = z.object({
  isActive: z.boolean(),
});

export function createCatalogRouter(
  catalogRepo: CatalogRepository,
  authRepo: AuthRepository
): Router {
  const router = Router();
  const requireWrite = requirePermission(authRepo, 'catalog.products.write');

  // Lecture accessible à tout utilisateur authentifié
  router.get('/categories', requireAuth(authRepo), (_req, res) => {
    res.json(catalogRepo.listCategories());
  });

  router.post('/categories', requireWrite, (req: AuthenticatedRequest, res, next) => {
    try {
      const parsed = categorySchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError('VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Catégorie invalide', 400);
      }
      res.status(201).json(
        catalogRepo.createCategory(req.authUser!.id, parsed.data.name, parsed.data.description)
      );
    } catch (err) {
      next(err);
    }
  });

  router.get('/brands', requireAuth(authRepo), (_req, res) => {
    res.json(catalogRepo.listBrands());
  });

  router.post('/brands', requireWrite, (req: AuthenticatedRequest, res, next) => {
    try {
      const parsed = brandSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError('VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Marque invalide', 400);
      }
      res.status(201).json(catalogRepo.createBrand(req.authUser!.id, parsed.data.name));
    } catch (err) {
      next(err);
    }
  });

  router.get('/units', requireAuth(authRepo), (_req, res) => {
    res.json(catalogRepo.listUnits());
  });

  router.get('/packaging-types', requireAuth(authRepo), (_req, res) => {
    res.json(catalogRepo.listPackagingTypes());
  });

  router.post('/packaging-types', requireWrite, (req: AuthenticatedRequest, res, next) => {
    try {
      const parsed = packagingTypeSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError('VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Emballage invalide', 400);
      }
      res.status(201).json(catalogRepo.createPackagingType(req.authUser!.id, parsed.data));
    } catch (err) {
      next(err);
    }
  });

  router.put('/packaging-types/:id', requireWrite, (req: AuthenticatedRequest, res, next) => {
    try {
      const parsed = updatePackagingTypeSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError('VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Emballage invalide', 400);
      }
      res.json(catalogRepo.updatePackagingType(req.authUser!.id, String(req.params.id), parsed.data));
    } catch (err) {
      next(err);
    }
  });

  router.get('/products', requireAuth(authRepo), (req, res) => {
    const search = typeof req.query.search === 'string' ? req.query.search : undefined;
    const categoryId = typeof req.query.categoryId === 'string' ? req.query.categoryId : undefined;
    const brandId = typeof req.query.brandId === 'string' ? req.query.brandId : undefined;
    const includeInactive = req.query.includeInactive === 'true';
    res.json(catalogRepo.listProducts({ search, categoryId, brandId, includeInactive }));
  });

  router.post('/products', requireWrite, (req: AuthenticatedRequest, res, next) => {
    try {
      const parsed = saveProductSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError('VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Produit invalide', 400);
      }
      res.status(201).json(catalogRepo.createProduct(req.authUser!.id, parsed.data));
    } catch (err) {
      next(err);
    }
  });

  router.put('/products/:id', requireWrite, (req: AuthenticatedRequest, res, next) => {
    try {
      const parsed = saveProductSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError('VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Produit invalide', 400);
      }
      res.json(catalogRepo.updateProduct(req.authUser!.id, String(req.params.id), parsed.data));
    } catch (err) {
      next(err);
    }
  });

  router.patch('/products/:id/active', requireWrite, (req: AuthenticatedRequest, res, next) => {
    try {
      const parsed = toggleActiveSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError('VALIDATION_ERROR', 'Statut invalide', 400);
      }
      res.json(
        catalogRepo.toggleProductActive(
          req.authUser!.id,
          String(req.params.id),
          parsed.data.isActive
        )
      );
    } catch (err) {
      next(err);
    }
  });

  return router;
}
