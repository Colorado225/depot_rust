import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { invokeBackend } from '@/src/lib/ipc';
import type { Brand, Category, PackagingType, Product, Unit } from '@/src/types/catalog';
import type {
  BrandFormValues,
  CategoryFormValues,
  PackagingTypeFormValues,
  ProductFormValues,
} from '../schemas/catalog.schema';

export const CATALOG_QUERY_KEYS = {
  categories: ['catalog', 'categories'] as const,
  brands: ['catalog', 'brands'] as const,
  units: ['catalog', 'units'] as const,
  packaging: ['catalog', 'packaging'] as const,
  products: (filters?: {
    search?: string;
    categoryId?: string;
    brandId?: string;
    includeInactive?: boolean;
  }) => ['catalog', 'products', filters ?? {}] as const,
};

export function useCategories() {
  return useQuery({
    queryKey: CATALOG_QUERY_KEYS.categories,
    queryFn: () => invokeBackend<Category[]>('catalog_list_categories'),
  });
}

export function useCreateCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (values: CategoryFormValues) =>
      invokeBackend<Category>('catalog_create_category', values),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: CATALOG_QUERY_KEYS.categories });
    },
  });
}

export function useBrands() {
  return useQuery({
    queryKey: CATALOG_QUERY_KEYS.brands,
    queryFn: () => invokeBackend<Brand[]>('catalog_list_brands'),
  });
}

export function useCreateBrand() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (values: BrandFormValues) =>
      invokeBackend<Brand>('catalog_create_brand', values),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: CATALOG_QUERY_KEYS.brands });
    },
  });
}

export function useUnits() {
  return useQuery({
    queryKey: CATALOG_QUERY_KEYS.units,
    queryFn: () => invokeBackend<Unit[]>('catalog_list_units'),
  });
}

export function usePackagingTypes() {
  return useQuery({
    queryKey: CATALOG_QUERY_KEYS.packaging,
    queryFn: () => invokeBackend<PackagingType[]>('catalog_list_packaging'),
  });
}

export function useCreatePackagingType() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (values: PackagingTypeFormValues) =>
      invokeBackend<PackagingType>('catalog_create_packaging', values),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: CATALOG_QUERY_KEYS.packaging });
    },
  });
}

export function useUpdatePackagingType() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      ...values
    }: {
      id: string;
      name: string;
      kind: 'BOTTLE' | 'CRATE' | 'OTHER';
      depositAmountXof: number;
    }) => invokeBackend<PackagingType>('catalog_update_packaging', { id, ...values }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: CATALOG_QUERY_KEYS.packaging });
      void qc.invalidateQueries({ queryKey: ['catalog', 'products'] });
    },
  });
}

export function useProducts(filters?: {
  search?: string;
  categoryId?: string;
  brandId?: string;
  includeInactive?: boolean;
}) {
  return useQuery({
    queryKey: CATALOG_QUERY_KEYS.products(filters),
    queryFn: () => invokeBackend<Product[]>('catalog_list_products', filters),
  });
}

export function useCreateProduct() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (values: ProductFormValues) =>
      invokeBackend<Product>('catalog_create_product', values),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['catalog', 'products'] });
      void qc.invalidateQueries({ queryKey: CATALOG_QUERY_KEYS.categories });
      void qc.invalidateQueries({ queryKey: CATALOG_QUERY_KEYS.brands });
    },
  });
}

export function useUpdateProduct() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, values }: { id: string; values: ProductFormValues }) =>
      invokeBackend<Product>('catalog_update_product', { id, ...values }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['catalog', 'products'] });
      void qc.invalidateQueries({ queryKey: CATALOG_QUERY_KEYS.categories });
      void qc.invalidateQueries({ queryKey: CATALOG_QUERY_KEYS.brands });
    },
  });
}

export function useToggleProductActive() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) =>
      invokeBackend<Product>('catalog_toggle_product_active', { id, isActive }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['catalog', 'products'] });
    },
  });
}
