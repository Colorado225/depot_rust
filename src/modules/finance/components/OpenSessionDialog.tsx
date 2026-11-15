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
import type { CashRegister } from '@/src/types/finance';
import { useOpenCashSession } from '../services/financeService';

interface OpenSessionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  registers: CashRegister[];
}

export function OpenSessionDialog({ open, onOpenChange, registers }: OpenSessionDialogProps) {
  const openMutation = useOpenCashSession();
  const [cashRegisterId, setCashRegisterId] = useState('');
  const [openingBalanceXof, setOpeningBalanceXof] = useState('0');
  const [notes, setNotes] = useState('');

  useEffect(() => {
    if (!open) return;
    setCashRegisterId(registers.find((r) => r.isActive)?.id ?? registers[0]?.id ?? '');
    setOpeningBalanceXof('0');
    setNotes('');
  }, [open, registers]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const amount = Number.parseInt(openingBalanceXof, 10);
    if (!Number.isFinite(amount) || amount < 0) {
      toast.error('Veuillez saisir un fond de caisse initial entier valide (>= 0).');
      return;
    }
    if (!cashRegisterId) {
      toast.error('Sélectionnez une caisse.');
      return;
    }

    try {
      await openMutation.mutateAsync({
        cashRegisterId,
        openingBalanceXof: amount,
        notes: notes.trim() || null,
      });
      toast.success('Session de caisse ouverte.');
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erreur ouverture de caisse');
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Ouverture de session de caisse</DialogTitle>
          <DialogDescription>
            Déclarez le fond de caisse initial présent physiquement dans le tiroir avant les encaissements.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
          <div className="space-y-1.5">
            <Label>Caisse *</Label>
            <Select value={cashRegisterId} onValueChange={setCashRegisterId}>
              <SelectTrigger>
                <SelectValue placeholder="Choisir une caisse" />
              </SelectTrigger>
              <SelectContent>
                {registers.map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    {r.code} — {r.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="open-float-xof">Fond de caisse initial (FCFA) *</Label>
            <Input
              id="open-float-xof"
              type="number"
              min={0}
              step={1}
              value={openingBalanceXof}
              onChange={(e) => setOpeningBalanceXof(e.target.value)}
              className="font-mono tabular-nums"
              required
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="open-notes">Observation (optionnel)</Label>
            <Input
              id="open-notes"
              placeholder="Ex. Shift matin — équipe A"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Annuler
            </Button>
            <Button type="submit" variant="accent" disabled={openMutation.isPending}>
              {openMutation.isPending ? 'Ouverture...' : 'Ouvrir la caisse'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
