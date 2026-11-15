import React, { useEffect } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Building2, ImagePlus, Save, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { AccessDeniedCard } from '@/src/components/AccessDeniedCard';
import { Button } from '@/src/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/src/components/ui/card';
import { Input } from '@/src/components/ui/input';
import { Label } from '@/src/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/src/components/ui/select';
import { Separator } from '@/src/components/ui/separator';
import { Skeleton } from '@/src/components/ui/skeleton';
import { Switch } from '@/src/components/ui/switch';
import { formatDateTimeFr, formatFCFA } from '@/src/lib/money';
import type { AuthenticatedUser } from '@/src/types/auth';
import {
  businessSettingsSchema,
  type BusinessSettingsFormValues,
} from '../schemas/settings.schema';
import {
  useBusinessSettings,
  useUpdateBusinessSettings,
} from '../services/settingsService';

interface DepotSettingsViewProps {
  currentUser: AuthenticatedUser;
}

export function DepotSettingsView({ currentUser }: DepotSettingsViewProps) {
  const hasPermission = currentUser.permissions.includes('settings.depot.manage');
  const { data: settings, isLoading } = useBusinessSettings(hasPermission);
  const updateMutation = useUpdateBusinessSettings();

  const {
    register,
    control,
    handleSubmit,
    reset,
    setValue,
    watch,
    formState: { errors },
  } = useForm<BusinessSettingsFormValues>({
    resolver: zodResolver(businessSettingsSchema) as never,
    defaultValues: {
      depotName: '',
      ownerName: '',
      phone: '',
      address: '',
      logoPath: '',
      receiptHeader: '',
      receiptFooter: '',
      defaultConsignmentPolicy: 'SEPARATE_TRACKING',
      allowNegativeStock: false,
      defaultCashFloatXof: 0,
      receiptPrintWidth: '80mm',
    },
  });

  useEffect(() => {
    if (settings) {
      reset({
        depotName: settings.depotName,
        ownerName: settings.ownerName,
        phone: settings.phone ?? '',
        address: settings.address ?? '',
        logoPath: settings.logoPath ?? '',
        receiptHeader: settings.receiptHeader ?? '',
        receiptFooter: settings.receiptFooter ?? '',
        defaultConsignmentPolicy: settings.defaultConsignmentPolicy,
        allowNegativeStock: settings.allowNegativeStock,
        defaultCashFloatXof: settings.defaultCashFloatXof,
        receiptPrintWidth: settings.receiptPrintWidth,
      });
    }
  }, [settings, reset]);

  if (!hasPermission) {
    return (
      <AccessDeniedCard
        requiredPermission="settings.depot.manage"
        userRoleName={currentUser.roleName}
      />
    );
  }

  const logoPath = watch('logoPath');
  const allowNegativeStock = watch('allowNegativeStock');
  const cashFloat = watch('defaultCashFloatXof');

  const handleLogoUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 400 * 1024) {
      toast.error('Le logo ne doit pas dépasser 400 Ko.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        setValue('logoPath', reader.result);
      }
    };
    reader.readAsDataURL(file);
  };

  const onSubmit = async (values: BusinessSettingsFormValues) => {
    try {
      await updateMutation.mutateAsync(values);
      toast.success('Paramètres du dépôt enregistrés.');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Échec d'enregistrement");
    }
  };

  if (isLoading || !settings) {
    return <Skeleton className="h-96 w-full rounded-lg" />;
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">
          Configuration du Dépôt
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Identité commerciale, paramètres de tickets, règles de consignes et caisse · Devise {settings.currency}
        </p>
      </div>

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Building2 className="h-4 w-4 text-muted-foreground" />
              Coordonnées et identité
            </CardTitle>
            <CardDescription>
              Dernière modification : {formatDateTimeFr(settings.updatedAt)}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="cfg-depotName">Nom du dépôt *</Label>
                <Input id="cfg-depotName" {...register('depotName')} />
                {errors.depotName && (
                  <p className="text-xs text-destructive">{errors.depotName.message}</p>
                )}
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="cfg-ownerName">Nom du propriétaire *</Label>
                <Input id="cfg-ownerName" {...register('ownerName')} />
                {errors.ownerName && (
                  <p className="text-xs text-destructive">{errors.ownerName.message}</p>
                )}
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="cfg-phone">Téléphone</Label>
                <Input id="cfg-phone" {...register('phone')} />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="cfg-address">Adresse</Label>
                <Input id="cfg-address" {...register('address')} />
              </div>
            </div>

            <Separator />

            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="space-y-0.5">
                <Label>Logo du dépôt</Label>
                <p className="text-xs text-muted-foreground">
                  Utilisé sur l&apos;accueil et les tickets imprimés (max. 400 Ko).
                </p>
              </div>
              <div className="flex items-center gap-2">
                {logoPath && (
                  <>
                    <img
                      src={logoPath}
                      alt="Logo du dépôt"
                      referrerPolicy="no-referrer"
                      className="h-10 w-10 rounded-md border border-border object-cover"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setValue('logoPath', null)}
                    >
                      <Trash2 className="h-4 w-4" />
                      Retirer
                    </Button>
                  </>
                )}
                <label className="inline-flex h-9 cursor-pointer items-center gap-2 rounded-md border border-border bg-card px-3 text-xs font-medium text-foreground hover:bg-secondary whitespace-nowrap">
                  <ImagePlus className="h-4 w-4" />
                  Importer logo
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    className="sr-only"
                    onChange={handleLogoUpload}
                  />
                </label>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Tickets, Consignes et Caisse</CardTitle>
            <CardDescription>
              Paramètres opérationnels appliqués au point de vente et à la gestion des stocks.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="cfg-header">En-tête de ticket</Label>
                <Input id="cfg-header" {...register('receiptHeader')} />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="cfg-footer">Pied de ticket</Label>
                <Input id="cfg-footer" {...register('receiptFooter')} />
              </div>

              <div className="space-y-1.5">
                <Label>Largeur papier ticket</Label>
                <Controller
                  name="receiptPrintWidth"
                  control={control}
                  render={({ field }) => (
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="80mm">80 mm (Standard POS)</SelectItem>
                        <SelectItem value="58mm">58 mm (Compact)</SelectItem>
                      </SelectContent>
                    </Select>
                  )}
                />
              </div>

              <div className="space-y-1.5">
                <Label>Politique des consignes</Label>
                <Controller
                  name="defaultConsignmentPolicy"
                  control={control}
                  render={({ field }) => (
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="SEPARATE_TRACKING">
                          Suivi séparé strict (Emballages vs Ventes)
                        </SelectItem>
                        <SelectItem value="AUTO_INCLUDE_CRATES">
                          Facturation automatique des casiers non rendus
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  )}
                />
              </div>

              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="cfg-cashFloat">
                  Fonds de caisse par défaut ({formatFCFA(Number(cashFloat) || 0)})
                </Label>
                <Input
                  id="cfg-cashFloat"
                  type="number"
                  min={0}
                  step={1}
                  className="font-mono tabular-nums"
                  {...register('defaultCashFloatXof')}
                />
                {errors.defaultCashFloatXof && (
                  <p className="text-xs text-destructive">{errors.defaultCashFloatXof.message}</p>
                )}
              </div>
            </div>

            <div className="flex items-center justify-between gap-4 rounded-md border border-border p-3">
              <div>
                <Label htmlFor="cfg-negativeStock">Autoriser les stocks négatifs</Label>
                <p className="text-xs text-muted-foreground">
                  Laisser désactivé pour interdire toute vente dépassant le stock réel disponible.
                </p>
              </div>
              <Switch
                id="cfg-negativeStock"
                checked={allowNegativeStock}
                onCheckedChange={(checked) => setValue('allowNegativeStock', checked)}
              />
            </div>

            <div className="flex justify-end pt-2">
              <Button type="submit" variant="accent" disabled={updateMutation.isPending}>
                <Save className="h-4 w-4" />
                {updateMutation.isPending ? 'Enregistrement...' : 'Enregistrer la configuration'}
              </Button>
            </div>
          </CardContent>
        </Card>
      </form>
    </div>
  );
}
