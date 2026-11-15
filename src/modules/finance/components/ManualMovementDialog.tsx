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
import { formatFCFA } from '@/src/lib/money';
import type { CashSession } from '@/src/types/finance';
import { useManualCashMovement } from '../services/financeService';

interface ManualMovementDialogProps {
  session: CashSession | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ManualMovementDialog({
  session,
  open,
  onOpenChange,
}: ManualMovementDialogProps) {
  const movementMutation = useManualCashMovement();
  const [direction, setDirection] = useState<'IN' | 'OUT'>('IN');
  const [amountInput, setAmountInput] = useState('');
  const [description, setDescription] = useState('');

  useEffect(() => {
    if (open) {
      setDirection('IN');
      setAmountInput('');
      setDescription('');
    }
  }, [open]);

  if (!session) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const amountXof = Number.parseInt(amountInput, 10);
    if (!Number.isFinite(amountXof) || amountXof <= 0) {
      toast.error('Montant entier positif requis.');
      return;
    }

    try {
      await movementMutation.mutateAsync({
        cashSessionId: session.id,
        direction,
        amountXof,
        description: description.trim(),
      });
      toast.success(
        direction === 'IN'
          ? `Apport de ${formatFCFA(amountXof)} enregistré.`
          : `Retrait de ${formatFCFA(amountXof)} enregistré.`
      );
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erreur mouvement manuel');
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Mouvement manuel d’espèces</DialogTitle>
          <DialogDescription>
            Solde théorique actuel :{' '}
            <span className="font-mono font-semibold tabular-nums text-foreground">
              {formatFCFA(session.theoreticalClosingXof)}
            </span>
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
          <div className="flex items-center gap-1 rounded-lg bg-secondary p-1">
            {(
              [
                ['IN', 'Entrée / Apport (+)'],
                ['OUT', 'Sortie / Prélèvement (-)'],
              ] as const
            ).map(([k, label]) => (
              <button
                key={k}
                type="button"
                onClick={() => setDirection(k)}
                className={`flex-1 rounded-md px-2 py-1.5 text-xs font-medium whitespace-nowrap cursor-pointer ${
                  direction === k
                    ? 'bg-card text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="manual-cash-amount">Montant (FCFA) *</Label>
            <Input
              id="manual-cash-amount"
              type="number"
              min={1}
              step={1}
              value={amountInput}
              onChange={(e) => setAmountInput(e.target.value)}
              className="font-mono tabular-nums"
              placeholder="Ex. 25000"
              required
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="manual-cash-desc">Motif justificatif *</Label>
            <Input
              id="manual-cash-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Ex. Appoint monnaie / Dépôt coffre"
              required
              minLength={3}
            />
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Annuler
            </Button>
            <Button type="submit" variant="accent" disabled={movementMutation.isPending}>
              {movementMutation.isPending ? 'Validation...' : 'Enregistrer'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
