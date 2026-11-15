import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/src/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/src/components/ui/dialog';
import { Input } from '@/src/components/ui/input';
import { Label } from '@/src/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/src/components/ui/select';
import { formatFCFA } from '@/src/lib/money';
import { usePackagingTypes } from '@/src/modules/catalog/services/catalogService';
import { useCustomers } from '@/src/modules/customers/services/customerService';
import { useSuppliers } from '@/src/modules/suppliers/services/supplierService';
import {
  useCustomerConsignmentOperation,
  useDepotPackagingOperation,
  useSupplierConsignmentOperation,
} from '../services/consignmentService';

interface ConsignmentOperationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultScope: 'CUSTOMER' | 'SUPPLIER' | 'DEPOT';
}

export function ConsignmentOperationDialog({
  open,
  onOpenChange,
  defaultScope,
}: ConsignmentOperationDialogProps) {
  const [scope, setScope] = useState<'CUSTOMER' | 'SUPPLIER' | 'DEPOT'>(defaultScope);
  const [customerId, setCustomerId] = useState('');
  const [supplierId, setSupplierId] = useState('');
  const [packagingTypeId, setPackagingTypeId] = useState('');
  const [operation, setOperation] = useState<string>('SALE_DEPOSIT');
  const [quantity, setQuantity] = useState(1);
  const [note, setNote] = useState('');

  const { data: packagingTypes = [] } = usePackagingTypes();
  const { data: customers = [] } = useCustomers();
  const { data: suppliers = [] } = useSuppliers();

  const customerOp = useCustomerConsignmentOperation();
  const supplierOp = useSupplierConsignmentOperation();
  const depotOp = useDepotPackagingOperation();

  useEffect(() => {
    if (!open) return;
    setScope(defaultScope);
    setCustomerId(customers[0]?.id ?? '');
    setSupplierId(suppliers[0]?.id ?? '');
    setPackagingTypeId(packagingTypes[0]?.id ?? '');
    setQuantity(1);
    setNote('');
    if (defaultScope === 'CUSTOMER') setOperation('SALE_DEPOSIT');
    else if (defaultScope === 'SUPPLIER') setOperation('SUPPLIER_DEPOSIT');
    else setOperation('EXCHANGE');
  }, [open, defaultScope, customers, suppliers, packagingTypes]);

  const handleScopeChange = (next: 'CUSTOMER' | 'SUPPLIER' | 'DEPOT') => {
    setScope(next);
    if (next === 'CUSTOMER') setOperation('SALE_DEPOSIT');
    else if (next === 'SUPPLIER') setOperation('SUPPLIER_DEPOSIT');
    else setOperation('EXCHANGE');
  };

  const selectedPkg = packagingTypes.find((p) => p.id === packagingTypeId);
  const estimatedValue = (selectedPkg?.depositAmountXof ?? 0) * Math.max(0, quantity);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!packagingTypeId) {
      toast.error('Sélectionnez un type d’emballage.');
      return;
    }

    try {
      if (scope === 'CUSTOMER') {
        if (!customerId) {
          toast.error('Sélectionnez un client.');
          return;
        }
        await customerOp.mutateAsync({
          customerId,
          packagingTypeId,
          quantity,
          operation: operation as 'SALE_DEPOSIT' | 'EXCHANGE' | 'BREAKAGE' | 'LOSS',
          note: note.trim() || null,
        });
      } else if (scope === 'SUPPLIER') {
        if (!supplierId) {
          toast.error('Sélectionnez un fournisseur.');
          return;
        }
        await supplierOp.mutateAsync({
          supplierId,
          packagingTypeId,
          quantity,
          operation: operation as 'SUPPLIER_DEPOSIT' | 'SUPPLIER_RETURN',
          note: note.trim() || null,
        });
      } else {
        await depotOp.mutateAsync({
          packagingTypeId,
          quantity,
          operation: operation as 'EXCHANGE' | 'BREAKAGE' | 'LOSS',
          note: note.trim() || null,
        });
      }
      toast.success('Mouvement d’emballage enregistré et journalisé.');
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Opération impossible');
    }
  };

  const isPending = customerOp.isPending || supplierOp.isPending || depotOp.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Mouvement d’emballages consignés</DialogTitle>
          <DialogDescription>
            Enregistrez une consigne, un échange, une casse, une perte ou un retour fournisseur.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
          <div className="flex items-center gap-1 rounded-lg bg-secondary p-1">
            {(
              [
                ['CUSTOMER', 'Client'],
                ['SUPPLIER', 'Fournisseur'],
                ['DEPOT', 'Dépôt'],
              ] as const
            ).map(([k, label]) => (
              <button
                key={k}
                type="button"
                onClick={() => handleScopeChange(k)}
                className={`flex-1 rounded-md px-2 py-1.5 text-xs font-medium whitespace-nowrap cursor-pointer ${
                  scope === k
                    ? 'bg-card text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {scope === 'CUSTOMER' && (
            <div className="space-y-1.5">
              <Label>Client *</Label>
              <Select value={customerId} onValueChange={setCustomerId}>
                <SelectTrigger>
                  <SelectValue placeholder="Choisir un client" />
                </SelectTrigger>
                <SelectContent>
                  {customers.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.fullName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {scope === 'SUPPLIER' && (
            <div className="space-y-1.5">
              <Label>Fournisseur *</Label>
              <Select value={supplierId} onValueChange={setSupplierId}>
                <SelectTrigger>
                  <SelectValue placeholder="Choisir un fournisseur" />
                </SelectTrigger>
                <SelectContent>
                  {suppliers.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="space-y-1.5">
            <Label>Type d’emballage *</Label>
            <Select value={packagingTypeId} onValueChange={setPackagingTypeId}>
              <SelectTrigger>
                <SelectValue placeholder="Choisir bouteille / casier" />
              </SelectTrigger>
              <SelectContent>
                {packagingTypes.map((pkg) => (
                  <SelectItem key={pkg.id} value={pkg.id}>
                    {pkg.name} ({formatFCFA(pkg.depositAmountXof)})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Opération *</Label>
              <Select value={operation} onValueChange={setOperation}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {scope === 'CUSTOMER' && (
                    <>
                      <SelectItem value="SALE_DEPOSIT">Consigne facturée</SelectItem>
                      <SelectItem value="EXCHANGE">Échange standard</SelectItem>
                      <SelectItem value="BREAKAGE">Casse client</SelectItem>
                      <SelectItem value="LOSS">Perte client</SelectItem>
                    </>
                  )}
                  {scope === 'SUPPLIER' && (
                    <>
                      <SelectItem value="SUPPLIER_DEPOSIT">Réception consigne</SelectItem>
                      <SelectItem value="SUPPLIER_RETURN">Retour vide fournisseur</SelectItem>
                    </>
                  )}
                  {scope === 'DEPOT' && (
                    <>
                      <SelectItem value="EXCHANGE">Entrée / Échange dépôt</SelectItem>
                      <SelectItem value="BREAKAGE">Casse dépôt</SelectItem>
                      <SelectItem value="LOSS">Perte dépôt</SelectItem>
                    </>
                  )}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="cons-op-qty">Quantité *</Label>
              <Input
                id="cons-op-qty"
                type="number"
                min={1}
                value={quantity}
                onChange={(e) => setQuantity(Math.max(1, Number.parseInt(e.target.value, 10) || 1))}
                className="font-mono tabular-nums"
              />
            </div>
          </div>

          <div className="flex items-center justify-between rounded-md bg-secondary/50 px-3 py-2 text-xs">
            <span className="text-muted-foreground">Valeur consigne associée</span>
            <span className="font-mono font-semibold tabular-nums text-foreground">
              {formatFCFA(estimatedValue)}
            </span>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="cons-op-note">Note justificative</Label>
            <Input
              id="cons-op-note"
              placeholder="Ex: Casse lors du déchargement camion"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Annuler
            </Button>
            <Button type="submit" variant="accent" disabled={isPending}>
              {isPending ? 'Enregistrement...' : 'Valider le mouvement'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
