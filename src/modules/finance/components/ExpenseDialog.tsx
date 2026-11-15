import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
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
import { PAYMENT_METHOD_LABELS } from '@/src/modules/customers/services/customerService';
import type { CustomerPaymentMethod } from '@/src/types/customer';
import type { ExpenseCategory } from '@/src/types/finance';
import { useCreateExpenseCategory, useRecordExpense } from '../services/financeService';

interface ExpenseDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  categories: ExpenseCategory[];
}

export function ExpenseDialog({ open, onOpenChange, categories }: ExpenseDialogProps) {
  const recordMutation = useRecordExpense();
  const createCategoryMutation = useCreateExpenseCategory();

  const [categoryId, setCategoryId] = useState('');
  const [amountInput, setAmountInput] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<CustomerPaymentMethod>('CASH');
  const [expenseDate, setExpenseDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [receiptReference, setReceiptReference] = useState('');
  const [description, setDescription] = useState('');

  const [addingCategory, setAddingCategory] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState('');

  useEffect(() => {
    if (!open) return;
    setCategoryId(categories[0]?.id ?? '');
    setAmountInput('');
    setPaymentMethod('CASH');
    setExpenseDate(new Date().toISOString().slice(0, 10));
    setReceiptReference('');
    setDescription('');
    setAddingCategory(false);
    setNewCategoryName('');
  }, [open, categories]);

  const handleCreateCategory = async () => {
    if (newCategoryName.trim().length < 2) {
      toast.error('Nom de catégorie requis (min. 2 caractères).');
      return;
    }
    try {
      const created = await createCategoryMutation.mutateAsync({ name: newCategoryName.trim() });
      setCategoryId(created.id);
      setNewCategoryName('');
      setAddingCategory(false);
      toast.success(`Catégorie « ${created.name} » créée.`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erreur création catégorie');
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const amountXof = Number.parseInt(amountInput, 10);
    if (!Number.isFinite(amountXof) || amountXof <= 0) {
      toast.error('Veuillez saisir un montant entier positif.');
      return;
    }
    if (!categoryId) {
      toast.error('Sélectionnez une catégorie.');
      return;
    }

    try {
      await recordMutation.mutateAsync({
        categoryId,
        amountXof,
        paymentMethod,
        expenseDate,
        receiptReference: receiptReference.trim() || null,
        description: description.trim(),
      });
      toast.success('Dépense opérationnelle enregistrée.');
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Impossible d’enregistrer la dépense');
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Nouvelle dépense opérationnelle</DialogTitle>
          <DialogDescription>
            Les dépenses payées en espèces déduisent automatiquement la caisse ouverte en cours.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label>Catégorie *</Label>
              <button
                type="button"
                onClick={() => setAddingCategory((v) => !v)}
                className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline cursor-pointer"
              >
                <Plus className="h-3 w-3" />
                {addingCategory ? 'Annuler' : 'Nouvelle catégorie'}
              </button>
            </div>

            {addingCategory ? (
              <div className="flex items-center gap-2">
                <Input
                  placeholder="Nom de la catégorie (ex. Carburant)"
                  value={newCategoryName}
                  onChange={(e) => setNewCategoryName(e.target.value)}
                />
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={createCategoryMutation.isPending}
                  onClick={() => void handleCreateCategory()}
                >
                  Ajouter
                </Button>
              </div>
            ) : (
              <Select value={categoryId} onValueChange={setCategoryId}>
                <SelectTrigger>
                  <SelectValue placeholder="Choisir une catégorie" />
                </SelectTrigger>
                <SelectContent>
                  {categories.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="exp-amount">Montant (FCFA) *</Label>
              <Input
                id="exp-amount"
                type="number"
                min={1}
                step={1}
                value={amountInput}
                onChange={(e) => setAmountInput(e.target.value)}
                className="font-mono tabular-nums"
                placeholder="Ex. 15000"
                required
              />
            </div>

            <div className="space-y-1.5">
              <Label>Mode de règlement *</Label>
              <Select
                value={paymentMethod}
                onValueChange={(v) => setPaymentMethod(v as CustomerPaymentMethod)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(PAYMENT_METHOD_LABELS) as CustomerPaymentMethod[]).map((m) => (
                    <SelectItem key={m} value={m}>
                      {PAYMENT_METHOD_LABELS[m]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="exp-date">Date *</Label>
              <Input
                id="exp-date"
                type="date"
                value={expenseDate}
                onChange={(e) => setExpenseDate(e.target.value)}
                className="font-mono tabular-nums"
                required
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="exp-ref">N° Reçu / Justificatif</Label>
              <Input
                id="exp-ref"
                value={receiptReference}
                onChange={(e) => setReceiptReference(e.target.value)}
                placeholder="Ex. FACT-CIE-045"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="exp-desc">Description / Libellé *</Label>
            <Input
              id="exp-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Ex. Carburant tricycle livraison zone 4"
              required
              minLength={3}
            />
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Annuler
            </Button>
            <Button type="submit" variant="accent" disabled={recordMutation.isPending}>
              {recordMutation.isPending ? 'Enregistrement...' : 'Enregistrer la dépense'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
