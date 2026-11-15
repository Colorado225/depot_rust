import { useState } from 'react';
import { Database, RefreshCw, Search } from 'lucide-react';
import { Button } from '@/src/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/src/components/ui/card';
import { Input } from '@/src/components/ui/input';
import { Skeleton } from '@/src/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/src/components/ui/table';
import { formatDateTimeFr } from '@/src/lib/money';
import { useMigrationsOverview } from '../services/systemService';

export function DatabaseMigrationsView() {
  const { data, isLoading, isError, error, refetch, isFetching } = useMigrationsOverview();
  const [tableFilter, setTableFilter] = useState('');

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-48 w-full rounded-lg" />
        <Skeleton className="h-72 w-full rounded-lg" />
      </div>
    );
  }

  if (isError || !data) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-destructive">Erreur de lecture du schéma SQLite</CardTitle>
          <CardDescription>
            {error instanceof Error ? error.message : 'Impossible de charger les migrations.'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="outline" onClick={() => void refetch()}>
            <RefreshCw className="h-4 w-4" />
            Réessayer
          </Button>
        </CardContent>
      </Card>
    );
  }

  const filteredTables = data.tables.filter((t) =>
    t.name.toLowerCase().includes(tableFilter.trim().toLowerCase())
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            Base de données &amp; Migrations SQL
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Historique versionné des migrations appliquées et inventaire en direct des tables SQLite.
          </p>
        </div>
        <Button variant="outline" onClick={() => void refetch()} disabled={isFetching}>
          <RefreshCw className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
          Actualiser le schéma
        </Button>
      </div>

      {/* Migrations appliquées */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Database className="h-4 w-4 text-muted-foreground" />
            Migrations SQL versionnées ({data.migrations.length})
          </CardTitle>
          <CardDescription>
            Chaque script SQL est vérifié par empreinte SHA-256 avant toute exécution ultérieure.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {data.migrations.length === 0 ? (
            <div className="p-6 text-sm text-muted-foreground">
              Aucune migration enregistrée dans la base locale.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Version</TableHead>
                  <TableHead>Fichier</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead>Empreinte SHA-256</TableHead>
                  <TableHead className="text-right">Durée</TableHead>
                  <TableHead className="text-right">Appliquée le</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.migrations.map((m) => (
                  <TableRow key={m.version}>
                    <TableCell className="font-mono font-medium tabular-nums">
                      #{String(m.version).padStart(4, '0')}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{m.filename}</TableCell>
                    <TableCell className="capitalize">{m.description}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {m.checksumSha256.slice(0, 16)}…
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs tabular-nums">
                      {m.executionMs} ms
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs tabular-nums text-muted-foreground">
                      {formatDateTimeFr(m.appliedAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Inventaire des tables SQLite */}
      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle>Tables relationnelles ({data.tables.length})</CardTitle>
            <CardDescription>
              Comptage en temps réel des enregistrements persistés dans la base locale.
            </CardDescription>
          </div>
          <div className="relative w-full sm:w-64">
            <Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
            <Input
              value={tableFilter}
              onChange={(e) => setTableFilter(e.target.value)}
              placeholder="Filtrer une table..."
              className="pl-9"
              aria-label="Filtrer les tables SQLite"
            />
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {filteredTables.length === 0 ? (
            <div className="p-6 text-sm text-muted-foreground">
              Aucune table ne correspond au filtre &laquo; {tableFilter} &raquo;.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Nom de la table</TableHead>
                  <TableHead className="text-right">Lignes persistées</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredTables.map((t) => (
                  <TableRow key={t.name}>
                    <TableCell className="font-mono text-xs font-medium">{t.name}</TableCell>
                    <TableCell className="text-right font-mono text-sm tabular-nums">
                      {t.rowCount}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
