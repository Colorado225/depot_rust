import { useState } from 'react';
import { CheckCircle2, Clock, Play, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/src/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/src/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/src/components/ui/table';
import { formatDateTimeFr } from '@/src/lib/money';
import type { SelfTestReport } from '@/src/types/system';
import { useFoundationSelfTest } from '../services/systemService';

interface LotItem {
  lot: string;
  title: string;
  criterion: string;
  status: 'Terminé et vérifié' | 'Non commencé';
}

const EXECUTION_LOTS: LotItem[] = [
  {
    lot: 'LOT 0',
    title: 'Fondations',
    criterion: "L'application démarre, initialise SQLite (WAL + FK) et exécute les migrations.",
    status: 'Terminé et vérifié',
  },
  {
    lot: 'LOT 1',
    title: 'Authentification & Configuration',
    criterion: 'Un propriétaire peut initialiser son dépôt et accéder à l’application.',
    status: 'Terminé et vérifié',
  },
  {
    lot: 'LOT 2',
    title: 'Catalogue',
    criterion: 'Créer et gérer des produits avec plusieurs unités et conversions.',
    status: 'Terminé et vérifié',
  },
  {
    lot: 'LOT 3',
    title: 'Stock & Référentiel Fournisseurs',
    criterion: 'Entrées, sorties, casse, pertes, CUMP entier, inventaires et journal traçable.',
    status: 'Terminé et vérifié',
  },
  {
    lot: 'LOT 4',
    title: 'Achats & Fournisseurs',
    criterion: 'Réception partielle et complète opérationnelles avec mise à jour CUMP et dettes.',
    status: 'Terminé et vérifié',
  },
  {
    lot: 'LOT 5',
    title: 'Clients & POS',
    criterion: 'Réaliser une vente complète, paiement multi-canaux, crédit et ticket.',
    status: 'Terminé et vérifié',
  },
  {
    lot: 'LOT 6',
    title: 'Consignes & Emballages',
    criterion: 'Aucune confusion entre stock commercial et emballages consignés.',
    status: 'Terminé et vérifié',
  },
  {
    lot: 'LOT 7',
    title: 'Finances & Caisse',
    criterion: 'Ouverture, dépenses, clôtures, écarts et réconciliation.',
    status: 'Terminé et vérifié',
  },
  {
    lot: 'LOT 8',
    title: 'Rapports',
    criterion: 'Tableaux de bord et exports PDF/CSV/Excel alignés sur les écritures.',
    status: 'Terminé et vérifié',
  },
  {
    lot: 'LOT 9',
    title: 'Fiabilisation',
    criterion: 'Sauvegardes WAL, restauration vérifiée, non-régression.',
    status: 'Non commencé',
  },
  {
    lot: 'LOT 10',
    title: 'Distribution Desktop',
    criterion: 'Installateurs Windows (MSI/EXE) et macOS (DMG/APP) signés et testés.',
    status: 'Non commencé',
  },
];

export function LotRoadmapVerificationView() {
  const selfTestMutation = useFoundationSelfTest();
  const [report, setReport] = useState<SelfTestReport | null>(null);

  const handleRunSelfTests = async () => {
    try {
      const result = await selfTestMutation.mutateAsync();
      setReport(result);
      if (result.allPassed) {
        toast.success('Tous les contrôles critiques du LOT 0 ont réussi');
      } else {
        toast.error('Un ou plusieurs contrôles du LOT 0 ont échoué');
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Échec d'exécution des vérifications");
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            Vérification LOT 0 &amp; Plan d&apos;exécution
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Tests transactionnels en direct sur la base SQLite et suivi strict lot par lot.
          </p>
        </div>
        <Button
          variant="accent"
          onClick={() => void handleRunSelfTests()}
          disabled={selfTestMutation.isPending}
        >
          <Play className="h-4 w-4" />
          {selfTestMutation.isPending ? 'Exécution...' : 'Exécuter les tests LOT 0'}
        </Button>
      </div>

      {/* Résultats des tests en direct */}
      <Card>
        <CardHeader>
          <CardTitle>Batterie d&apos;auto-vérification backend (SQLite + Domaine XOF)</CardTitle>
          <CardDescription>
            Exécute de vraies vérifications SQLite sous transaction (WAL, rejet FK orpheline, rollback, arithmétique entière).
          </CardDescription>
        </CardHeader>
        <CardContent>
          {!report ? (
            <div className="rounded-md border border-dashed border-border p-6 text-center">
              <p className="text-sm text-muted-foreground">
                Cliquez sur &laquo; Exécuter les tests LOT 0 &raquo; pour lancer la vérification en direct sur la base locale.
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span className="flex items-center gap-2 font-medium">
                  {report.allPassed ? (
                    <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                  ) : (
                    <XCircle className="h-4 w-4 text-destructive" />
                  )}
                  {report.allPassed
                    ? 'Tous les contrôles critiques LOT 0 sont conformes'
                    : 'Échec détecté sur un contrôle'}
                </span>
                <span className="font-mono text-xs tabular-nums text-muted-foreground">
                  Exécuté le {formatDateTimeFr(report.executedAt)}
                </span>
              </div>

              <div className="divide-y divide-border rounded-md border border-border">
                {report.checks.map((check) => (
                  <div
                    key={check.id}
                    className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="flex items-center gap-2.5">
                      {check.passed ? (
                        <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                      ) : (
                        <XCircle className="h-4 w-4 shrink-0 text-destructive" />
                      )}
                      <span className="text-sm font-medium text-foreground">{check.label}</span>
                    </div>
                    <span className="font-mono text-xs text-muted-foreground">{check.details}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Tableau de progression des lots */}
      <Card>
        <CardHeader>
          <CardTitle>Feuille de route par lots (Implementtion.md)</CardTitle>
          <CardDescription>
            Aucun lot suivant n&apos;est entamé avant la validation complète du lot courant.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Lot</TableHead>
                <TableHead>Périmètre</TableHead>
                <TableHead>Critère de validation</TableHead>
                <TableHead className="text-right">État</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {EXECUTION_LOTS.map((item) => (
                <TableRow key={item.lot}>
                  <TableCell className="font-mono text-xs font-semibold whitespace-nowrap">
                    {item.lot}
                  </TableCell>
                  <TableCell className="font-medium whitespace-nowrap">{item.title}</TableCell>
                  <TableCell className="text-muted-foreground">{item.criterion}</TableCell>
                  <TableCell className="text-right whitespace-nowrap">
                    {item.status === 'Terminé et vérifié' ? (
                      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-700 dark:text-emerald-400">
                        <CheckCircle2 className="h-3.5 w-3.5" />
                        {item.status}
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                        <Clock className="h-3.5 w-3.5" />
                        {item.status}
                      </span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
