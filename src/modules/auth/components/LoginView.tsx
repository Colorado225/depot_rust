import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Lock, Moon, Sun } from 'lucide-react';
import { toast } from 'sonner';
import { useTheme } from '@/src/components/ThemeProvider';
import { Button } from '@/src/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/src/components/ui/card';
import { Input } from '@/src/components/ui/input';
import { Label } from '@/src/components/ui/label';
import type { BootstrapStatus } from '@/src/types/auth';
import { loginSchema, type LoginFormValues } from '../schemas/auth.schema';
import { useLogin } from '../services/authService';

interface LoginViewProps {
  bootstrap: BootstrapStatus;
}

export function LoginView({ bootstrap }: LoginViewProps) {
  const { theme, toggleTheme } = useTheme();
  const loginMutation = useLogin();

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<LoginFormValues>({
    resolver: zodResolver(loginSchema),
    defaultValues: { username: '', password: '' },
  });

  const onSubmit = async (values: LoginFormValues) => {
    try {
      const session = await loginMutation.mutateAsync(values);
      toast.success(`Session ouverte : ${session.user.fullName} (${session.user.roleName})`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Échec de connexion');
    }
  };

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background px-4 py-8 text-foreground">
      <div className="mb-4 flex w-full max-w-md justify-end">
        <Button variant="ghost" size="sm" onClick={toggleTheme} type="button">
          {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          {theme === 'dark' ? 'Mode clair' : 'Mode sombre'}
        </Button>
      </div>

      <Card className="w-full max-w-md">
        <CardHeader className="space-y-3 text-center">
          {bootstrap.logoPath ? (
            <img
              src={bootstrap.logoPath}
              alt={bootstrap.depotName ?? 'Logo du dépôt'}
              referrerPolicy="no-referrer"
              className="mx-auto h-14 w-14 rounded-lg border border-border object-cover"
            />
          ) : (
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-lg border border-border bg-secondary text-foreground">
              <Lock className="h-5 w-5" />
            </div>
          )}
          <div>
            <CardTitle className="text-xl">
              {bootstrap.depotName ?? 'DepotPro CI'}
            </CardTitle>
            <CardDescription className="mt-1">
              Connexion locale sécurisée · Fonctionnement hors ligne
            </CardDescription>
          </div>
        </CardHeader>

        <CardContent>
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="login-username">Identifiant</Label>
              <Input
                id="login-username"
                placeholder="Votre identifiant"
                autoComplete="username"
                autoFocus
                {...register('username')}
              />
              {errors.username && (
                <p className="text-xs text-destructive">{errors.username.message}</p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="login-password">Mot de passe</Label>
              <Input
                id="login-password"
                type="password"
                placeholder="••••••••"
                autoComplete="current-password"
                {...register('password')}
              />
              {errors.password && (
                <p className="text-xs text-destructive">{errors.password.message}</p>
              )}
            </div>

            {loginMutation.isError && (
              <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {loginMutation.error instanceof Error
                  ? loginMutation.error.message
                  : 'Identifiants invalides'}
              </p>
            )}

            <Button
              type="submit"
              variant="accent"
              className="w-full"
              disabled={loginMutation.isPending}
            >
              {loginMutation.isPending ? 'Vérification...' : 'Se connecter'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
