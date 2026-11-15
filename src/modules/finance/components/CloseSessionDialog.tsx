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
import { useCloseCashSession } from '../services/financeService';

interface CloseSessionDialogProps {
  session: CashSession | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CloseSessionDialog({ session, open, onOpenChange }: CloseSessionDialogProps) {
  const closeMutation = useCloseCashSession();
  const [declaredInput, setDeclaredInput] = useState('0');
  const [notes, setNotes] = useState('');

  useEffect(() => {
    if (open && session) {
      setDeclaredInput(String(session.theoreticalClosingXof));
      setNotes('');
    }
  }, [open, session]);

  if (!session) return null;

  const declaredClosingXof = Number.parseInt(declaredInput, 10);
  const validDeclared = Number.isFinite(declaredClosingXof) && declaredClosingXof >= 0;
  const varianceXof = validDeclared ? declaredClosingXof - session.theoreticalClosingXof : 0;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!validDeclared) {
      toast.error('Veuillez saisir le montant compté entier (>= 0).');
      return;
    }

    try {
      const closed = await closeMutation.mutateAsync({
        id: session.id,
        declaredClosingXof,
        notes: notes.trim() || null,
      });
      const v = closed.varianceXof ?? 0;
      if (v === 0) {
        toast.success('Caisse clôturée sans écart.');
      } else {
        toast.warning(
          `Caisse clôturée avec un écart de ${v > 0 ? `+${formatFCFA(v)}` : formatFCFA(v)}.`
        );
      }
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erreur lors de la clôture');
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Clôture et comptage de caisse</DialogTitle>
          <DialogDescription>
            {session.registerCode} — {session.registerName} · Ouverte par {session.openedByName}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
          <div className="divide-y divide-border rounded-md border border-border bg-secondary/30 text-sm">
            <div className="flex items-center justify-between px-3 py-2">
              <span className="text-muted-foreground">Fond initial</span>
              <span className="font-mono tabular-nums">{formatFCFA(session.openingBalanceXof)}</span>
            </div>
            <div className="flex items-center justify-between px-3 py-2">
              <span className="text-muted-foreground">Entrées espèces (+)</span>
              <span className="font-mono tabular-nums text-emerald-700 dark:text-emerald-400">
                +{formatFCFA(session.cashInXof)}
              </span>
            </div>
            <div className="flex items-center justify-between px-3 py-2">
              <span className="text-muted-foreground">Sorties espèces (-)</span>
              <span className="font-mono tabular-nums text-amber-700 dark:text-amber-400">
                -{formatFCFA(session.cashOutXof)}
              </span>
            </div>
            <div className="flex items-center justify-between px-3 py-2.5 font-semibold">
              <span>Solde théorique attendu</span>
              <span className="font-mono tabular-nums">
                {formatFCFA(session.theoreticalClosingXof)}
              </span>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="close-declared-xof">Montant physique compté (FCFA) *</Label>
            <Input
              id="close-declared-xof"
              type="number"
              min={0}
              step={1}
              value={declaredInput}
              onChange={(e) => setDeclaredInput(e.target.value)}
              className="font-mono text-base font-semibold tabular-nums"
              required
            />
          </div>

          {validDeclared && (
            <div className="flex items-center justify-between rounded-md border border-border px-3 py-2.5 text-sm">
              <span className="text-muted-foreground">Écart calculé</span>
              <span
                className={`font-mono font-semibold tabular-nums ${
                  varianceXof === 0
                    ? 'text-emerald-700 dark:text-emerald-400'
                    : varianceXof > 0
                      ? 'text-sky-700 dark:text-sky-400'
                      : 'text-destructive'
                }`}
              >
                {varianceXof === 0
                  ? '0 FCFA (Caisse exacte)'
                  : `${varianceXof > 0 ? '+' : ''}${formatFCFA(varianceXof)} (${
                      varianceXof > 0 ? 'Excédent' : 'Manquant'
                    })`}
              </span>
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="close-notes">
              Observation / Justification {varianceXof !== 0 ? '(recommandée)' : '(optionnel)'}
            </Label>
            <Input
              id="close-notes"
              placeholder="Ex. Billets vérifiés avec le gérant"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Annuler
            </Button>
            <Button type="submit" variant="accent" disabled={closeMutation.isPending}>
              {closeMutation.isPending ? 'Clôture...' : 'Valider la clôture'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
