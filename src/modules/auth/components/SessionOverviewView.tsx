import { CheckCircle2, KeyRound, LogOut, Shield, UserCheck } from 'lucide-react';
import { Button } from '@/src/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/src/components/ui/card';
import { formatDateTimeFr } from '@/src/lib/money';
import type { AuthenticatedUser } from '@/src/types/auth';

interface SessionOverviewViewProps {
  user: AuthenticatedUser;
  depotName: string | null;
  onOpenPasswordDialog: () => void;
  onLogout: () => void;
}

export function SessionOverviewView({
  user,
  depotName,
  onOpenPasswordDialog,
  onLogout,
}: SessionOverviewViewProps) {
  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            Mon poste &amp; Habilitations
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {depotName ?? 'DepotPro CI'} · Session locale active
          </p>
        </div>
        <div className="flex items-center gap-2.5">
          <Button variant="outline" onClick={onOpenPasswordDialog}>
            <KeyRound className="h-4 w-4" />
            Changer mot de passe
          </Button>
          <Button variant="destructive" onClick={onLogout}>
            <LogOut className="h-4 w-4" />
            Déconnexion
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <UserCheck className="h-4 w-4 text-muted-foreground" />
              Identité de session
            </CardTitle>
            <CardDescription>
              Informations vérifiées auprès de la base SQLite locale.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="flex items-center justify-between border-b border-border pb-2">
              <span className="text-muted-foreground">Nom complet</span>
              <span className="font-medium">{user.fullName}</span>
            </div>
            <div className="flex items-center justify-between border-b border-border pb-2">
              <span className="text-muted-foreground">Identifiant</span>
              <span className="font-mono text-xs font-medium">{user.username}</span>
            </div>
            <div className="flex items-center justify-between border-b border-border pb-2">
              <span className="text-muted-foreground">Rôle attribué</span>
              <span className="font-medium">{user.roleName}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Dernière connexion</span>
              <span className="font-mono text-xs tabular-nums text-muted-foreground">
                {formatDateTimeFr(user.lastLoginAt)}
              </span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Shield className="h-4 w-4 text-muted-foreground" />
              Permissions actives ({user.permissions.length})
            </CardTitle>
            <CardDescription>
              Chaque action sensible est contrôlée côté backend selon ces droits.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {user.permissions.map((perm) => (
                <li
                  key={perm}
                  className="flex items-center gap-2 text-xs font-mono text-foreground"
                >
                  <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                  <span className="truncate">{perm}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
