import { ShieldAlert } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/src/components/ui/card';

interface AccessDeniedCardProps {
  requiredPermission: string;
  userRoleName?: string;
}

export function AccessDeniedCard({ requiredPermission, userRoleName }: AccessDeniedCardProps) {
  return (
    <Card className="mx-auto max-w-xl">
      <CardHeader>
        <div className="flex items-center gap-2.5 text-destructive">
          <ShieldAlert className="h-5 w-5 shrink-0" />
          <CardTitle>Accès refusé</CardTitle>
        </div>
        <CardDescription>
          Votre profil actuel ({userRoleName ?? 'Utilisateur'}) ne dispose pas des droits requis pour consulter ou modifier cette section.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <p className="font-mono text-xs text-muted-foreground">
          Permission requise : {requiredPermission}
        </p>
      </CardContent>
    </Card>
  );
}
