import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  CheckCircle2,
  LockOpen,
  ShieldCheck,
  UserPlus,
  Users,
  XCircle,
} from 'lucide-react';
import { toast } from 'sonner';
import { AccessDeniedCard } from '@/src/components/AccessDeniedCard';
import { Button } from '@/src/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/src/components/ui/card';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/src/components/ui/select';
import { Skeleton } from '@/src/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/src/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/src/components/ui/tabs';
import { formatDateTimeFr } from '@/src/lib/money';
import type { AuthenticatedUser } from '@/src/types/auth';
import { createUserSchema, type CreateUserFormValues } from '../schemas/auth.schema';
import {
  useCreateUser,
  useLoginLogs,
  useRolesList,
  useToggleUserStatus,
  useUnlockUser,
  useUpdateUserRole,
  useUsersList,
} from '../services/authService';

interface UsersManagementViewProps {
  currentUser: AuthenticatedUser;
}

export function UsersManagementView({ currentUser }: UsersManagementViewProps) {
  const hasPermission = currentUser.permissions.includes('auth.users.manage');
  const [createOpen, setCreateOpen] = useState(false);

  const { data: users, isLoading: loadingUsers } = useUsersList(hasPermission);
  const { data: roles, isLoading: loadingRoles } = useRolesList(hasPermission);
  const { data: loginLogs, isLoading: loadingLogs } = useLoginLogs(hasPermission);

  const createMutation = useCreateUser();
  const toggleMutation = useToggleUserStatus();
  const unlockMutation = useUnlockUser();
  const updateRoleMutation = useUpdateUserRole();

  const {
    register,
    control,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<CreateUserFormValues>({
    resolver: zodResolver(createUserSchema),
    defaultValues: {
      fullName: '',
      phone: '',
      jobTitle: '',
      username: '',
      password: '',
      roleId: 'role-cashier',
    },
  });

  if (!hasPermission) {
    return (
      <AccessDeniedCard
        requiredPermission="auth.users.manage"
        userRoleName={currentUser.roleName}
      />
    );
  }

  const onCreateUser = async (values: CreateUserFormValues) => {
    try {
      const created = await createMutation.mutateAsync(values);
      toast.success(`Compte créé : ${created.fullName} (${created.roleName})`);
      reset();
      setCreateOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erreur lors de la création');
    }
  };

  const handleToggleActive = async (userId: string, nextActive: boolean) => {
    try {
      await toggleMutation.mutateAsync({ userId, isActive: nextActive });
      toast.success(nextActive ? 'Compte réactivé.' : 'Compte désactivé.');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Action refusée');
    }
  };

  const handleUnlock = async (userId: string) => {
    try {
      await unlockMutation.mutateAsync(userId);
      toast.success('Compte déverrouillé.');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Échec du déverrouillage');
    }
  };

  const handleRoleChange = async (userId: string, roleId: string) => {
    try {
      await updateRoleMutation.mutateAsync({ userId, roleId });
      toast.success('Rôle mis à jour.');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Impossible de modifier le rôle');
    }
  };

  const isLocked = (lockedUntil: string | null): boolean => {
    if (!lockedUntil) return false;
    const ms = Date.parse(lockedUntil);
    return !Number.isNaN(ms) && ms > Date.now();
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            Employés, Utilisateurs &amp; Permissions
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Contrôle d&apos;accès basé sur les rôles (RBAC) vérifié côté serveur à chaque opération.
          </p>
        </div>
        <Button variant="accent" onClick={() => setCreateOpen(true)}>
          <UserPlus className="h-4 w-4" />
          Nouvel employé
        </Button>
      </div>

      <Tabs defaultValue="users">
        <TabsList>
          <TabsTrigger value="users">Comptes ({users?.length ?? 0})</TabsTrigger>
          <TabsTrigger value="roles">Rôles &amp; Permissions ({roles?.length ?? 0})</TabsTrigger>
          <TabsTrigger value="logs">Journal des connexions ({loginLogs?.length ?? 0})</TabsTrigger>
        </TabsList>

        <TabsContent value="users">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Users className="h-4 w-4 text-muted-foreground" />
                Comptes utilisateurs du dépôt
              </CardTitle>
              <CardDescription>
                Verrouillage automatique après 5 échecs de connexion consécutifs.
              </CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              {loadingUsers ? (
                <div className="p-6">
                  <Skeleton className="h-40 w-full" />
                </div>
              ) : !users || users.length === 0 ? (
                <div className="p-6 text-sm text-muted-foreground">
                  Aucun utilisateur trouvé.
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Employé</TableHead>
                      <TableHead>Identifiant</TableHead>
                      <TableHead>Rôle</TableHead>
                      <TableHead>État</TableHead>
                      <TableHead>Dernière connexion</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {users.map((u) => {
                      const locked = isLocked(u.lockedUntil);
                      return (
                        <TableRow key={u.id}>
                          <TableCell>
                            <div className="font-medium text-foreground">{u.fullName}</div>
                            <div className="text-xs text-muted-foreground">
                              {u.jobTitle ?? u.roleName}
                              {u.phone ? ` · ${u.phone}` : ''}
                            </div>
                          </TableCell>
                          <TableCell className="font-mono text-xs">{u.username}</TableCell>
                          <TableCell>
                            <Select
                              value={u.roleId}
                              onValueChange={(nextRole) => void handleRoleChange(u.id, nextRole)}
                              disabled={updateRoleMutation.isPending}
                            >
                              <SelectTrigger className="h-8 w-40 text-xs">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {roles?.map((r) => (
                                  <SelectItem key={r.id} value={r.id}>
                                    {r.name}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </TableCell>
                          <TableCell>
                            {locked ? (
                              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-600 dark:text-amber-400">
                                <XCircle className="h-3.5 w-3.5" />
                                Verrouillé ({u.failedAttempts} échecs)
                              </span>
                            ) : u.isActive ? (
                              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-700 dark:text-emerald-400">
                                <CheckCircle2 className="h-3.5 w-3.5" />
                                Actif
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-destructive">
                                <XCircle className="h-3.5 w-3.5" />
                                Désactivé
                              </span>
                            )}
                          </TableCell>
                          <TableCell className="font-mono text-xs tabular-nums text-muted-foreground">
                            {formatDateTimeFr(u.lastLoginAt)}
                          </TableCell>
                          <TableCell className="text-right">
                            <div className="inline-flex items-center gap-2">
                              {locked && (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => void handleUnlock(u.id)}
                                  disabled={unlockMutation.isPending}
                                >
                                  <LockOpen className="h-3.5 w-3.5" />
                                  Déverrouiller
                                </Button>
                              )}
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => void handleToggleActive(u.id, !u.isActive)}
                                disabled={toggleMutation.isPending || u.id === currentUser.id}
                              >
                                {u.isActive ? 'Désactiver' : 'Réactiver'}
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="roles">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {loadingRoles ? (
              <Skeleton className="h-48 w-full md:col-span-2" />
            ) : (
              roles?.map((role) => (
                <Card key={role.id}>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-base">
                      <ShieldCheck className="h-4 w-4 text-muted-foreground" />
                      {role.name}
                    </CardTitle>
                    <CardDescription>
                      {role.description ?? role.code} · {role.permissions.length} permissions
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <ul className="space-y-1.5 text-xs">
                      {role.permissions.map((perm) => (
                        <li
                          key={perm.id}
                          className="flex items-baseline justify-between gap-3 border-b border-border/60 pb-1 last:border-none"
                        >
                          <span className="text-foreground">{perm.description}</span>
                          <span className="font-mono text-[11px] text-muted-foreground shrink-0">
                            {perm.code}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </CardContent>
                </Card>
              ))
            )}
          </div>
        </TabsContent>

        <TabsContent value="logs">
          <Card>
            <CardHeader>
              <CardTitle>Journal des tentatives de connexion</CardTitle>
              <CardDescription>
                Historique immuable des connexions réussies, refusées et verrouillages.
              </CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              {loadingLogs ? (
                <div className="p-6">
                  <Skeleton className="h-40 w-full" />
                </div>
              ) : !loginLogs || loginLogs.length === 0 ? (
                <div className="p-6 text-sm text-muted-foreground">
                  Aucun événement de connexion enregistré.
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Horodatage</TableHead>
                      <TableHead>Identifiant tenté</TableHead>
                      <TableHead>Résultat</TableHead>
                      <TableHead>Motif</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {loginLogs.map((log) => (
                      <TableRow key={log.id}>
                        <TableCell className="font-mono text-xs tabular-nums text-muted-foreground">
                          {formatDateTimeFr(log.createdAt)}
                        </TableCell>
                        <TableCell className="font-mono text-xs font-medium">
                          {log.usernameAttempted}
                        </TableCell>
                        <TableCell>
                          {log.success ? (
                            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-700 dark:text-emerald-400">
                              <CheckCircle2 className="h-3.5 w-3.5" />
                              Succès
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-destructive">
                              <XCircle className="h-3.5 w-3.5" />
                              Refusé
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground">
                          {log.reason ?? '—'}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Modale création employé & compte */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Créer un employé et son compte</DialogTitle>
            <DialogDescription>
              Le rôle sélectionné détermine immédiatement les permissions vérifiées par le backend.
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleSubmit(onCreateUser)} className="space-y-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="new-fullName">Nom complet *</Label>
                <Input id="new-fullName" placeholder="Ex. Koné Ibrahim" {...register('fullName')} />
                {errors.fullName && (
                  <p className="text-xs text-destructive">{errors.fullName.message}</p>
                )}
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="new-phone">Téléphone (optionnel)</Label>
                <Input id="new-phone" placeholder="Ex. 05 00 00 00 00" {...register('phone')} />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="new-jobTitle">Poste (optionnel)</Label>
                <Input id="new-jobTitle" placeholder="Ex. Caissier principal" {...register('jobTitle')} />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="new-username">Identifiant *</Label>
                <Input id="new-username" placeholder="Ex. ikone" {...register('username')} />
                {errors.username && (
                  <p className="text-xs text-destructive">{errors.username.message}</p>
                )}
              </div>

              <div className="space-y-1.5">
                <Label>Rôle *</Label>
                <Controller
                  name="roleId"
                  control={control}
                  render={({ field }) => (
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger>
                        <SelectValue placeholder="Sélectionner un rôle" />
                      </SelectTrigger>
                      <SelectContent>
                        {roles?.map((r) => (
                          <SelectItem key={r.id} value={r.id}>
                            {r.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
                {errors.roleId && (
                  <p className="text-xs text-destructive">{errors.roleId.message}</p>
                )}
              </div>

              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="new-password">Mot de passe initial (min. 8 caractères) *</Label>
                <Input id="new-password" type="password" {...register('password')} />
                {errors.password && (
                  <p className="text-xs text-destructive">{errors.password.message}</p>
                )}
              </div>
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setCreateOpen(false)}>
                Annuler
              </Button>
              <Button type="submit" variant="accent" disabled={createMutation.isPending}>
                {createMutation.isPending ? 'Création...' : 'Créer le compte'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
