import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { CheckCircle2, KeyRound, RotateCcw, Shield } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/src/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/src/components/ui/card';
import { Input } from '@/src/components/ui/input';
import { Label } from '@/src/components/ui/label';
import { Separator } from '@/src/components/ui/separator';
import { Skeleton } from '@/src/components/ui/skeleton';
import { formatDateTimeFr } from '@/src/lib/money';
import {
  activateLicenseSchema,
  type ActivateLicenseFormValues,
} from '../schemas/license.schema';
import {
  useActivateLicense,
  useArchitectureDecisions,
  useLicenseState,
  useResetTrialLicense,
} from '../services/systemService';

export function ArchitectureDecisionsView() {
  const { data: decisions, isLoading: loadingAdr } = useArchitectureDecisions();
  const { data: license, isLoading: loadingLicense } = useLicenseState();
  const activateMutation = useActivateLicense();
  const resetMutation = useResetTrialLicense();

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<ActivateLicenseFormValues>({
    resolver: zodResolver(activateLicenseSchema),
    defaultValues: {
      licenseKey: '',
      depotNameBound: '',
    },
  });

  const onSubmit = async (values: ActivateLicenseFormValues) => {
    try {
      const updated = await activateMutation.mutateAsync(values);
      toast.success(`Licence locale activée pour « ${updated.depotNameBound} »`);
      reset();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Échec de l'activation locale");
    }
  };

  const handleResetTrial = async () => {
    try {
      await resetMutation.mutateAsync();
      toast.success('Licence locale remise en mode évaluation hors ligne');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Échec de réinitialisation');
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">
          Décisions d&apos;Architecture &amp; Licence Locale (LOT 0)
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Traçabilité des 3 décisions structurantes validées avant le développement fonctionnel.
        </p>
      </div>

      {/* 3 Décisions d'architecture persistées dans system_meta */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Shield className="h-4 w-4 text-muted-foreground" />
            Registre des décisions structurantes (SQLite system_meta)
          </CardTitle>
          <CardDescription>
            Ces paramètres gouvernent le périmètre V1 sans bloquer les évolutions futures.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {loadingAdr ? (
            <div className="space-y-3">
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          ) : (
            decisions?.map((item, idx) => (
              <div key={item.key}>
                {idx > 0 && <Separator className="mb-4" />}
                <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <span className="font-mono font-semibold text-foreground">{item.key}</span>
                      <span aria-hidden="true">·</span>
                      <span>{item.category}</span>
                    </div>
                    <p className="text-sm text-muted-foreground">
                      {item.description ?? 'Paramètre système'}
                    </p>
                  </div>
                  <div className="shrink-0 font-mono text-xs font-semibold text-foreground">
                    {item.value}
                  </div>
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      {/* Séparation Licence / Données du Dépôt */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <KeyRound className="h-4 w-4 text-muted-foreground" />
              État actuel de la licence locale
            </CardTitle>
            <CardDescription>
              Stockée séparément de business_settings. Le fonctionnement hors ligne reste toujours actif.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {loadingLicense || !license ? (
              <Skeleton className="h-32 w-full" />
            ) : (
              <div className="space-y-3 text-sm">
                <div className="flex items-center justify-between border-b border-border pb-2">
                  <span className="text-muted-foreground">Identifiant poste</span>
                  <span className="font-mono text-xs font-medium">{license.installationId}</span>
                </div>
                <div className="flex items-center justify-between border-b border-border pb-2">
                  <span className="text-muted-foreground">Statut</span>
                  <span className="flex items-center gap-1.5 font-mono text-xs font-semibold text-emerald-700 dark:text-emerald-400">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    {license.status}
                  </span>
                </div>
                <div className="flex items-center justify-between border-b border-border pb-2">
                  <span className="text-muted-foreground">Dépôt lié</span>
                  <span className="font-medium">{license.depotNameBound ?? 'Non lié (Mode autonome)'}</span>
                </div>
                <div className="flex items-center justify-between border-b border-border pb-2">
                  <span className="text-muted-foreground">Clé enregistrée</span>
                  <span className="font-mono text-xs">{license.licenseKeyMasked ?? 'Aucune clé requise'}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Mode hors ligne autorisé</span>
                  <span className="font-medium">
                    {license.offlineAllowed ? 'Oui (Inconditionnel)' : 'Non'}
                  </span>
                </div>
                {license.activatedAt && (
                  <p className="pt-1 font-mono text-xs text-muted-foreground">
                    Activée le {formatDateTimeFr(license.activatedAt)}
                  </p>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Activer une licence locale (facultatif)</CardTitle>
            <CardDescription>
              Permet d&apos;enregistrer une clé commerciale locale sans connexion Internet (ex. DPCI-AB26-CI01).
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="depotNameBound">Nom du dépôt bénéficiaire</Label>
                <Input
                  id="depotNameBound"
                  placeholder="Ex. Dépôt Koumassi Boissons"
                  {...register('depotNameBound')}
                />
                {errors.depotNameBound && (
                  <p className="text-xs text-destructive">{errors.depotNameBound.message}</p>
                )}
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="licenseKey">Clé d&apos;activation locale</Label>
                <Input
                  id="licenseKey"
                  placeholder="DPCI-XXXX-XXXX"
                  className="font-mono uppercase"
                  {...register('licenseKey')}
                />
                {errors.licenseKey && (
                  <p className="text-xs text-destructive">{errors.licenseKey.message}</p>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-2.5 pt-1">
                <Button type="submit" variant="accent" disabled={activateMutation.isPending}>
                  {activateMutation.isPending ? 'Enregistrement...' : 'Enregistrer la licence locale'}
                </Button>
                {license?.status === 'ACTIVE_OFFLINE' && (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => void handleResetTrial()}
                    disabled={resetMutation.isPending}
                  >
                    <RotateCcw className="h-4 w-4" />
                    Revenir en mode évaluation
                  </Button>
                )}
              </div>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
