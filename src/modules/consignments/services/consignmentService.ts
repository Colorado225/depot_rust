import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { invokeBackend } from '@/src/lib/ipc';
import type {
  ConsignmentBalance,
  ConsignmentHolderType,
  ConsignmentMovement,
  ConsignmentMovementType,
  ConsignmentSummary,
  CustomerConsignmentOperationInput,
  CustomerConsignmentReturnInput,
  DepotPackagingOperationInput,
  SupplierConsignmentOperationInput,
} from '@/src/types/consignment';

export const CONSIGNMENT_MOVEMENT_LABELS: Record<ConsignmentMovementType, string> = {
  SALE_DEPOSIT: 'Consigne facturée',
  CUSTOMER_RETURN: 'Retour client',
  REFUND: 'Remboursement consigne',
  EXCHANGE: 'Échange emballages',
  SUPPLIER_DEPOSIT: 'Consigne fournisseur',
  SUPPLIER_RETURN: 'Retour fournisseur',
  BREAKAGE: 'Casse emballage',
  LOSS: 'Perte emballage',
};

export const PACKAGING_KIND_LABELS: Record<'BOTTLE' | 'CRATE' | 'OTHER', string> = {
  BOTTLE: 'Bouteilles vides',
  CRATE: 'Casiers vides',
  OTHER: 'Autres emballages',
};

export function useConsignmentSummary() {
  return useQuery({
    queryKey: ['consignments', 'summary'],
    queryFn: () => invokeBackend<ConsignmentSummary>('consignments_summary'),
  });
}

export function useConsignmentBalances(
  filter: {
    holderType?: ConsignmentHolderType;
    holderId?: string;
    kind?: 'BOTTLE' | 'CRATE' | 'OTHER';
    onlyNonZero?: boolean;
  } = {}
) {
  return useQuery({
    queryKey: ['consignments', 'balances', filter],
    queryFn: () => invokeBackend<ConsignmentBalance[]>('consignments_balances', filter),
  });
}

export function useConsignmentMovements(
  filter: {
    holderType?: ConsignmentHolderType;
    packagingTypeId?: string;
    movementType?: ConsignmentMovementType;
    limit?: number;
  } = {}
) {
  return useQuery({
    queryKey: ['consignments', 'movements', filter],
    queryFn: () => invokeBackend<ConsignmentMovement[]>('consignments_movements', filter),
  });
}

export function useCustomerConsignmentReturn() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CustomerConsignmentReturnInput) =>
      invokeBackend<{
        movementId: string;
        remainingCustomerQty: number;
        refundedAmountXof: number;
      }>('consignments_customer_return', input as unknown as Record<string, unknown>),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['consignments'] });
      void qc.invalidateQueries({ queryKey: ['customers'] });
    },
  });
}

export function useCustomerConsignmentOperation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CustomerConsignmentOperationInput) =>
      invokeBackend<ConsignmentMovement>(
        'consignments_customer_operation',
        input as unknown as Record<string, unknown>
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['consignments'] });
      void qc.invalidateQueries({ queryKey: ['customers'] });
    },
  });
}

export function useSupplierConsignmentOperation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SupplierConsignmentOperationInput) =>
      invokeBackend<ConsignmentMovement>(
        'consignments_supplier_operation',
        input as unknown as Record<string, unknown>
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['consignments'] });
      void qc.invalidateQueries({ queryKey: ['suppliers'] });
    },
  });
}

export function useDepotPackagingOperation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: DepotPackagingOperationInput) =>
      invokeBackend<ConsignmentMovement>(
        'consignments_depot_operation',
        input as unknown as Record<string, unknown>
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['consignments'] });
    },
  });
}
