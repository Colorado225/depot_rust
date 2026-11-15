import React, { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Building2, ImagePlus, Moon, ShieldCheck, Sun, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { useTheme } from '@/src/components/ThemeProvider';
import { Button } from '@/src/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/src/components/ui/card';
import { Input } from '@/src/components/ui/input';
import { Label } from '@/src/components/ui/label';
import { Separator } from '@/src/components/ui/separator';
import { Switch } from '@/src/components/ui/switch';
import { setupDepotSchema, type SetupDepotFormValues } from '../schemas/auth.schema';
import { useInitializeDepot } from '../services/authService';

export function OnboardingWizard() {
  const { theme, toggleTheme } = useTheme();
  const initMutation = useInitializeDepot();
  const [logoPreview, setLogoPreview] = useState<string>('');

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    formState: { errors },
  } = useForm<SetupDepotFormValues>({
    resolver: zodResolver(setupDepotSchema) as never,
    defaultValues: {
      depotName: '',
      ownerFullName: '',
      phone: '',
      address: '',
      logoPath: '',
      receiptHeader: '',
      receiptFooter: 'Merci pour votre confiance !',
      defaultCashFloatXof: 0,
      allowNegativeStock: false,
      username: '',
      password: '',
      confirmPassword: '',
    },
  });

  const allowNegativeStock = watch('allowNegativeStock');

  const handleLogoFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 400 * 1024) {
      toast.error('Le logo ne doit pas dépasser 400 Ko.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      setLogoPreview(result);
      setValue('logoPath', result);
    };
    reader.readAsDataURL(file);
  };

  const onSubmit = async (values: SetupDepotFormValues) => {
    try {
      const session = await initMutation.mutateAsync(values);
      toast.success(`Dépôt « ${values.depotName} » initialisé. Bienvenue, ${session.user.fullName}.`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Échec lors de l'initialisation");
    }
  };

  return (
    <div className="min-h-screen bg-background px-4 py-8 text-foreground sm:px-6">
      <div className="mx-auto max-w-3xl space-y-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="font-display text-2xl font-bold tracking-tight text-foreground">
              DepotPro CI — Initialisation du Dépôt
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Première configuration hors ligne · Devise FCFA (XOF) · Compte Propriétaire
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={toggleTheme} type="button">
            {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            {theme === 'dark' ? 'Clair' : 'Sombre'}
          </Button>
        </div>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Building2 className="h-4 w-4 text-muted-foreground" />
                1. Identité et paramètres du dépôt
              </CardTitle>
              <CardDescription>
                Seul le nom du dépôt est obligatoire. Les coordonnées et paramètres de ticket sont modifiables à tout moment.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="space-y-1.5 sm:col-span-2">
                  <Label htmlFor="depotName">Nom du dépôt *</Label>
                  <Input
                    id="depotName"
                    placeholder="Ex. Dépôt Boissons du Plateau"
                    {...register('depotName')}
                  />
                  {errors.depotName && (
                    <p className="text-xs text-destructive">{errors.depotName.message}</p>
                  )}
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="phone">Téléphone (optionnel)</Label>
                  <Input
                    id="phone"
                    placeholder="Ex. +225 07 00 00 00 00"
                    {...register('phone')}
                  />
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="defaultCashFloatXof">Fonds de caisse initial (FCFA)</Label>
                  <Input
                    id="defaultCashFloatXof"
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

                <div className="space-y-1.5 sm:col-span-2">
                  <Label htmlFor="address">Adresse / Commune (optionnel)</Label>
                  <Input
                    id="address"
                    placeholder="Ex. Yopougon Sicogi, Abidjan"
                    {...register('address')}
                  />
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="receiptHeader">En-tête de ticket (optionnel)</Label>
                  <Input
                    id="receiptHeader"
                    placeholder="Ex. Vente en gros & détail"
                    {...register('receiptHeader')}
                  />
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="receiptFooter">Pied de ticket (optionnel)</Label>
                  <Input
                    id="receiptFooter"
                    placeholder="Merci pour votre confiance !"
                    {...register('receiptFooter')}
                  />
                </div>
              </div>

              <Separator />

              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="space-y-1">
                  <Label>Logo du dépôt (optionnel, PNG/JPG &le; 400 Ko)</Label>
                  <p className="text-xs text-muted-foreground">
                    Affiché sur l&apos;écran de connexion et les futurs tickets PDF.
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {logoPreview && (
                    <>
                      <img
                        src={logoPreview}
                        alt="Aperçu du logo"
                        referrerPolicy="no-referrer"
                        className="h-10 w-10 rounded-md border border-border object-cover"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setLogoPreview('');
                          setValue('logoPath', '');
                        }}
                      >
                        <Trash2 className="h-4 w-4" />
                        Retirer
                      </Button>
                    </>
                  )}
                  <label className="inline-flex h-9 cursor-pointer items-center gap-2 rounded-md border border-border bg-card px-3 text-xs font-medium text-foreground hover:bg-secondary whitespace-nowrap">
                    <ImagePlus className="h-4 w-4" />
                    Choisir un logo
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      className="sr-only"
                      onChange={handleLogoFileChange}
                    />
                  </label>
                </div>
              </div>

              <div className="flex items-center justify-between gap-4 rounded-md border border-border p-3">
                <div>
                  <Label htmlFor="allowNegativeStock">Autoriser les stocks négatifs</Label>
                  <p className="text-xs text-muted-foreground">
                    Désactivé par défaut conformément à la règle métier n° 9.
                  </p>
                </div>
                <Switch
                  id="allowNegativeStock"
                  checked={allowNegativeStock}
                  onCheckedChange={(checked) => setValue('allowNegativeStock', checked)}
                />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <ShieldCheck className="h-4 w-4 text-muted-foreground" />
                2. Création du compte Propriétaire
              </CardTitle>
              <CardDescription>
                Ce compte dispose de l&apos;ensemble des permissions d&apos;administration, caisse et sauvegardes.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="ownerFullName">Nom complet du propriétaire *</Label>
                  <Input
                    id="ownerFullName"
                    placeholder="Ex. Kouassi Jean-Marc"
                    {...register('ownerFullName')}
                  />
                  {errors.ownerFullName && (
                    <p className="text-xs text-destructive">{errors.ownerFullName.message}</p>
                  )}
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="username">Identifiant de connexion *</Label>
                  <Input
                    id="username"
                    placeholder="Ex. patron"
                    autoComplete="username"
                    {...register('username')}
                  />
                  {errors.username && (
                    <p className="text-xs text-destructive">{errors.username.message}</p>
                  )}
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="password">Mot de passe (min. 8 caractères) *</Label>
                  <Input
                    id="password"
                    type="password"
                    autoComplete="new-password"
                    {...register('password')}
                  />
                  {errors.password && (
                    <p className="text-xs text-destructive">{errors.password.message}</p>
                  )}
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="confirmPassword">Confirmer le mot de passe *</Label>
                  <Input
                    id="confirmPassword"
                    type="password"
                    autoComplete="new-password"
                    {...register('confirmPassword')}
                  />
                  {errors.confirmPassword && (
                    <p className="text-xs text-destructive">{errors.confirmPassword.message}</p>
                  )}
                </div>
              </div>

              <div className="flex justify-end pt-2">
                <Button type="submit" variant="accent" size="lg" disabled={initMutation.isPending}>
                  {initMutation.isPending
                    ? 'Initialisation en cours...'
                    : 'Initialiser le dépôt et ouvrir la session'}
                </Button>
              </div>
            </CardContent>
          </Card>
        </form>
      </div>
    </div>
  );
}
