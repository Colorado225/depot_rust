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
import { Skeleton } from '@/src/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/src/components/ui/table';
import { formatDateTimeFr, formatFCFA } from '@/src/lib/money';
import { PAYMENT_METHOD_LABELS } from '@/src/modules/customers/services/customerService';
import {
  CASH_MOVEMENT_LABELS,
  useCashSessionDetail,
  useOverrideCashSession,
} from '../services/financeService';

interface SessionDetailDialogProps {
  sessionId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  canOverride: boolean;
}

export function SessionDetailDialog({
  sessionId,
  open,
  onOpenChange,
  canOverride,
}: SessionDetailDialogProps) {
  const { data: detail, isLoading } = useCashSessionDetail(open ? sessionId : null);
  const overrideMutation = useOverrideCashSession();

  const [overrideMode, setOverrideMode] = useState(false);
  const [correctedDeclared, setCorrectedDeclared] = useState('');
  const [justification, setJustification] = useState('');

  useEffect(() => {
    if (open && detail?.session) {
      setOverrideMode(false);
      setCorrectedDeclared(
        String(detail.session.declaredClosingXof ?? detail.session.theoreticalClosingXof)
      );
      setJustification('');
    }
  }, [open, detail?.session]);

  const handleOverrideSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!detail) return;
    const corrected = Number.parseInt(correctedDeclared, 10);
    if (!Number.isFinite(corrected) || corrected < 0) {
      toast.error('Montant corrigé invalide.');
      return;
    }

    try {
      await overrideMutation.mutateAsync({
        id: detail.session.id,
        correctedDeclaredXof: corrected,
        justification: justification.trim(),
      });
      toast.success('Clôture rectifiée et journalisée dans l’audit.');
      setOverrideMode(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erreur rectification');
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Détail de session &amp; réconciliation</DialogTitle>
          <DialogDescription>
            {detail
              ? `${detail.session.registerCode} — ${detail.session.registerName} · Ouverte le ${formatDateTimeFr(
                  detail.session.openedAt
                )} par ${detail.session.openedByName}`
              : 'Chargement du journal de caisse...'}
          </DialogDescription>
        </DialogHeader>

        {isLoading || !detail ? (
          <div className="space-y-3 py-4">
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        ) : (
          <div className="space-y-5">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div className="rounded-md border border-border p-3">
                <div className="text-xs text-muted-foreground">Fond initial</div>
                <div className="mt-1 font-mono text-sm font-semibold tabular-nums">
                  {formatFCFA(detail.session.openingBalanceXof)}
                </div>
              </div>
              <div className="rounded-md border border-border p-3">
                <div className="text-xs text-muted-foreground">Théorique</div>
                <div className="mt-1 font-mono text-sm font-semibold tabular-nums">
                  {formatFCFA(detail.session.theoreticalClosingXof)}
                </div>
              </div>
              <div className="rounded-md border border-border p-3">
                <div className="text-xs text-muted-foreground">Compté déclaré</div>
                <div className="mt-1 font-mono text-sm font-semibold tabular-nums">
                  {detail.session.declaredClosingXof !== null
                    ? formatFCFA(detail.session.declaredClosingXof)
                    : 'Session ouverte'}
                </div>
              </div>
              <div className="rounded-md border border-border p-3">
                <div className="text-xs text-muted-foreground">Écart</div>
                <div
                  className={`mt-1 font-mono text-sm font-semibold tabular-nums ${
                    detail.session.varianceXof === null || detail.session.varianceXof === 0
                      ? 'text-emerald-700 dark:text-emerald-400'
                      : detail.session.varianceXof > 0
                        ? 'text-sky-700 dark:text-sky-400'
                        : 'text-destructive'
                  }`}
                >
                  {detail.session.varianceXof === null
                    ? '—'
                    : `${detail.session.varianceXof > 0 ? '+' : ''}${formatFCFA(
                        detail.session.varianceXof
                      )}`}
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Répartition multi-canaux de la session
              </h3>
              <div className="rounded-md border border-border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Canal</TableHead>
                      <TableHead className="text-right">Encaissements</TableHead>
                      <TableHead className="text-right">Décaissements tiers</TableHead>
                      <TableHead className="text-right">Dépenses</TableHead>
                      <TableHead className="text-right">Solde net</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {detail.session.channels.map((ch) => (
                      <TableRow key={ch.paymentMethod}>
                        <TableCell className="text-xs font-medium">
                          {PAYMENT_METHOD_LABELS[ch.paymentMethod]}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs tabular-nums">
                          {formatFCFA(ch.inboundXof)}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs tabular-nums text-muted-foreground">
                          {formatFCFA(ch.outboundPaymentsXof)}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs tabular-nums text-muted-foreground">
                          {formatFCFA(ch.expensesXof)}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs font-semibold tabular-nums">
                          {formatFCFA(ch.netXof)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>

            <div className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Journal des mouvements espèces ({detail.movements.length})
              </h3>
              <div className="rounded-md border border-border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Libellé</TableHead>
                      <TableHead>Opérateur</TableHead>
                      <TableHead className="text-right">Montant</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {detail.movements.map((mov) => (
                      <TableRow key={mov.id}>
                        <TableCell className="font-mono text-xs tabular-nums text-muted-foreground whitespace-nowrap">
                          {formatDateTimeFr(mov.createdAt)}
                        </TableCell>
                        <TableCell className="text-xs font-medium">
                          {CASH_MOVEMENT_LABELS[mov.movementType]}
                        </TableCell>
                        <TableCell className="text-xs">{mov.description}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">{mov.userName}</TableCell>
                        <TableCell
                          className={`text-right font-mono text-xs font-semibold tabular-nums whitespace-nowrap ${
                            mov.amountSignedXof >= 0
                              ? 'text-emerald-700 dark:text-emerald-400'
                              : 'text-amber-700 dark:text-amber-400'
                          }`}
                        >
                          {mov.amountSignedXof > 0
                            ? `+${formatFCFA(mov.amountSignedXof)}`
                            : formatFCFA(mov.amountSignedXof)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>

            {detail.session.status === 'CLOSED' && canOverride && (
              <div className="rounded-md border border-border bg-secondary/30 p-4">
                {!overrideMode ? (
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <div className="text-xs text-muted-foreground">
                      Correction administrative traçable réservée au propriétaire (`cash.session.override`).
                    </div>
                    <Button size="sm" variant="outline" onClick={() => setOverrideMode(true)}>
                      Rectifier le comptage déclaré
                    </Button>
                  </div>
                ) : (
                  <form onSubmit={(e) => void handleOverrideSubmit(e)} className="space-y-3">
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <div className="space-y-1">
                        <Label htmlFor="ovr-amt" className="text-xs">
                          Nouveau montant compté (FCFA)
                        </Label>
                        <Input
                          id="ovr-amt"
                          type="number"
                          min={0}
                          value={correctedDeclared}
                          onChange={(e) => setCorrectedDeclared(e.target.value)}
                          className="h-9 font-mono text-xs tabular-nums"
                          required
                        />
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor="ovr-justif" className="text-xs">
                          Justification d’audit *
                        </Label>
                        <Input
                          id="ovr-justif"
                          value={justification}
                          onChange={(e) => setJustification(e.target.value)}
                          placeholder="Ex. Billet de 10 000 FCFA retrouvé sous tiroir"
                          className="h-9 text-xs"
                          required
                          minLength={5}
                        />
                      </div>
                    </div>
                    <div className="flex justify-end gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => setOverrideMode(false)}
                      >
                        Annuler
                      </Button>
                      <Button
                        type="submit"
                        size="sm"
                        variant="accent"
                        disabled={overrideMutation.isPending}
                      >
                        {overrideMutation.isPending ? 'Validation...' : 'Enregistrer la rectification'}
                      </Button>
                    </div>
                  </form>
                )}
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Fermer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
