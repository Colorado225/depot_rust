import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  Activity,
  BarChart3,
  Boxes,
  Building2,
  CheckSquare,
  Database,
  KeyRound,
  Landmark,
  LogOut,
  Menu,
  Moon,
  Package,
  Receipt,
  Shield,
  ShoppingCart,
  Sun,
  Truck,
  UserCheck,
  UserCircle2,
  Users,
  Warehouse,
  X,
} from 'lucide-react';
import { Toaster, toast } from 'sonner';
import { ErrorBoundary } from '@/src/components/ErrorBoundary';
import { ThemeProvider, useTheme } from '@/src/components/ThemeProvider';
import { Button } from '@/src/components/ui/button';
import { Skeleton } from '@/src/components/ui/skeleton';
import { getStoredSessionToken } from '@/src/lib/ipc';
import { cn } from '@/src/lib/utils';
import { ChangePasswordDialog } from '@/src/modules/auth/components/ChangePasswordDialog';
import { LoginView } from '@/src/modules/auth/components/LoginView';
import { OnboardingWizard } from '@/src/modules/auth/components/OnboardingWizard';
import { SessionOverviewView } from '@/src/modules/auth/components/SessionOverviewView';
import { UsersManagementView } from '@/src/modules/auth/components/UsersManagementView';
import {
  useBootstrapStatus,
  useCurrentUser,
  useLogout,
} from '@/src/modules/auth/services/authService';
import { CatalogManagementView } from '@/src/modules/catalog/components/CatalogManagementView';
import { ConsignmentsView } from '@/src/modules/consignments/components/ConsignmentsView';
import { FinanceView } from '@/src/modules/finance/components/FinanceView';
import { ArchitectureDecisionsView } from '@/src/modules/foundations/components/ArchitectureDecisionsView';
import { DatabaseMigrationsView } from '@/src/modules/foundations/components/DatabaseMigrationsView';
import { LotRoadmapVerificationView } from '@/src/modules/foundations/components/LotRoadmapVerificationView';
import { SystemOverviewView } from '@/src/modules/foundations/components/SystemOverviewView';
import { DepotSettingsView } from '@/src/modules/settings/components/DepotSettingsView';
import { CustomersView } from '@/src/modules/customers/components/CustomersView';
import { PosView } from '@/src/modules/pos/components/PosView';
import { PurchasesView } from '@/src/modules/purchases/components/PurchasesView';
import { ReportsView } from '@/src/modules/reports/components/ReportsView';
import { StockManagementView } from '@/src/modules/stock/components/StockManagementView';
import { SuppliersView } from '@/src/modules/suppliers/components/SuppliersView';
import type { AuthenticatedUser, BootstrapStatus } from '@/src/types/auth';

type NavSectionId =
  | 'session'
  | 'pos'
  | 'customers'
  | 'consignments'
  | 'catalog'
  | 'stock'
  | 'purchases'
  | 'suppliers'
  | 'finance'
  | 'reports'
  | 'settings'
  | 'users'
  | 'overview'
  | 'database'
  | 'architecture'
  | 'verification';

interface NavItem {
  id: NavSectionId;
  label: string;
  icon: typeof Activity;
  requiredPermission?: string;
}

const NAV_ITEMS: NavItem[] = [
  { id: 'session', label: 'Mon poste', icon: UserCheck },
  { id: 'pos', label: 'Point de Vente POS', icon: Receipt },
  { id: 'customers', label: 'Clients & Créances', icon: UserCircle2 },
  { id: 'consignments', label: 'Consignes & Emballages', icon: Boxes },
  { id: 'catalog', label: 'Catalogue & Tarifs', icon: Package },
  { id: 'stock', label: 'Stock & Mouvements', icon: Warehouse },
  { id: 'purchases', label: 'Achats & Réceptions', icon: ShoppingCart },
  { id: 'suppliers', label: 'Fournisseurs', icon: Truck },
  { id: 'finance', label: 'Finances & Caisse', icon: Landmark },
  {
    id: 'reports',
    label: 'Rapports & Marges',
    icon: BarChart3,
    requiredPermission: 'reports.view',
  },
  {
    id: 'settings',
    label: 'Configuration du dépôt',
    icon: Building2,
    requiredPermission: 'settings.depot.manage',
  },
  {
    id: 'users',
    label: 'Employés & RBAC',
    icon: Users,
    requiredPermission: 'auth.users.manage',
  },
  {
    id: 'overview',
    label: 'Santé système',
    icon: Activity,
    requiredPermission: 'settings.depot.manage',
  },
  {
    id: 'database',
    label: 'Base SQLite & Migrations',
    icon: Database,
    requiredPermission: 'settings.depot.manage',
  },
  {
    id: 'architecture',
    label: 'Architecture & Licence',
    icon: Shield,
    requiredPermission: 'settings.depot.manage',
  },
  {
    id: 'verification',
    label: 'Vérification & Lots',
    icon: CheckSquare,
    requiredPermission: 'settings.depot.manage',
  },
];

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 10_000,
    },
  },
});

function AuthenticatedWorkspace({
  user,
  bootstrap,
}: {
  user: AuthenticatedUser;
  bootstrap: BootstrapStatus;
}) {
  const defaultSection: NavSectionId = user.permissions.includes('settings.depot.manage')
    ? 'settings'
    : 'session';

  const [activeSection, setActiveSection] = useState<NavSectionId>(defaultSection);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [passwordDialogOpen, setPasswordDialogOpen] = useState(false);
  const { theme, toggleTheme } = useTheme();
  const logoutMutation = useLogout();

  const visibleNavItems = NAV_ITEMS.filter(
    (item) => !item.requiredPermission || user.permissions.includes(item.requiredPermission)
  );
  const activeNav = NAV_ITEMS.find((item) => item.id === activeSection) ?? NAV_ITEMS[0];

  const handleLogout = async () => {
    try {
      await logoutMutation.mutateAsync();
      toast.success('Session fermée.');
    } catch {
      toast.success('Session fermée.');
    }
  };

  return (
    <div className="flex min-h-screen bg-background text-foreground">
      {mobileMenuOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/40 lg:hidden"
          onClick={() => setMobileMenuOpen(false)}
          aria-hidden="true"
        />
      )}

      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-40 flex w-64 shrink-0 flex-col border-r border-border bg-card transition-transform duration-150 lg:static lg:translate-x-0',
          mobileMenuOpen ? 'translate-x-0' : '-translate-x-full'
        )}
      >
        <div className="flex h-14 items-center justify-between border-b border-border px-5">
          <div className="flex min-w-0 items-center gap-2.5">
            {bootstrap.logoPath && (
              <img
                src={bootstrap.logoPath}
                alt=""
                referrerPolicy="no-referrer"
                className="h-6 w-6 shrink-0 rounded object-cover"
              />
            )}
            <span className="block truncate font-display text-base font-bold tracking-tight text-foreground">
              {bootstrap.depotName ?? 'DepotPro CI'}
            </span>
          </div>
          <button
            type="button"
            onClick={() => setMobileMenuOpen(false)}
            className="rounded-md p-1.5 text-muted-foreground hover:bg-secondary lg:hidden"
            aria-label="Fermer le menu"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-5 py-3 text-xs text-muted-foreground">
          {user.fullName} · {user.roleName}
        </div>

        <nav className="flex-1 space-y-1 px-3" aria-label="Navigation principale">
          {visibleNavItems.map((item) => {
            const Icon = item.icon;
            const isActive = activeSection === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  setActiveSection(item.id);
                  setMobileMenuOpen(false);
                }}
                className={cn(
                  'flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left text-sm font-medium transition-colors whitespace-nowrap cursor-pointer',
                  isActive
                    ? 'bg-secondary text-foreground'
                    : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground'
                )}
              >
                <Icon className="h-4 w-4 shrink-0" />
                <span className="truncate">{item.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="space-y-1 border-t border-border p-3">
          <button
            type="button"
            onClick={() => setPasswordDialogOpen(true)}
            className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground cursor-pointer"
          >
            <KeyRound className="h-4 w-4" />
            <span>Changer mot de passe</span>
          </button>
          <button
            type="button"
            onClick={toggleTheme}
            className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground cursor-pointer"
          >
            {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            <span>{theme === 'dark' ? 'Mode clair' : 'Mode sombre'}</span>
          </button>
          <button
            type="button"
            onClick={() => void handleLogout()}
            className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium text-destructive transition-colors hover:bg-destructive/10 cursor-pointer"
          >
            <LogOut className="h-4 w-4" />
            <span>Déconnexion</span>
          </button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center justify-between gap-4 border-b border-border bg-card px-4 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <button
              type="button"
              onClick={() => setMobileMenuOpen(true)}
              className="rounded-md p-2 text-muted-foreground hover:bg-secondary lg:hidden"
              aria-label="Ouvrir le menu"
            >
              <Menu className="h-4 w-4" />
            </button>
            <div className="flex min-w-0 items-center gap-2 text-sm">
              <span className="hidden text-muted-foreground sm:inline whitespace-nowrap">
                DepotPro CI
              </span>
              <span className="hidden text-muted-foreground sm:inline" aria-hidden="true">
                /
              </span>
              <span className="truncate font-medium text-foreground">{activeNav.label}</span>
            </div>
          </div>

          <Button size="sm" variant="outline" onClick={() => void handleLogout()}>
            <LogOut className="h-4 w-4" />
            Déconnexion
          </Button>
        </header>

        <main className="mx-auto w-full max-w-7xl flex-1 p-4 sm:p-6">
          {activeSection === 'session' && (
            <SessionOverviewView
              user={user}
              depotName={bootstrap.depotName}
              onOpenPasswordDialog={() => setPasswordDialogOpen(true)}
              onLogout={() => void handleLogout()}
            />
          )}
          {activeSection === 'pos' && <PosView currentUser={user} />}
          {activeSection === 'customers' && <CustomersView currentUser={user} />}
          {activeSection === 'consignments' && <ConsignmentsView currentUser={user} />}
          {activeSection === 'catalog' && <CatalogManagementView currentUser={user} />}
          {activeSection === 'stock' && <StockManagementView currentUser={user} />}
          {activeSection === 'purchases' && <PurchasesView currentUser={user} />}
          {activeSection === 'suppliers' && <SuppliersView currentUser={user} />}
          {activeSection === 'finance' && <FinanceView currentUser={user} />}
          {activeSection === 'reports' && <ReportsView currentUser={user} />}
          {activeSection === 'settings' && <DepotSettingsView currentUser={user} />}
          {activeSection === 'users' && <UsersManagementView currentUser={user} />}
          {activeSection === 'overview' && <SystemOverviewView />}
          {activeSection === 'database' && <DatabaseMigrationsView />}
          {activeSection === 'architecture' && <ArchitectureDecisionsView />}
          {activeSection === 'verification' && <LotRoadmapVerificationView />}
        </main>
      </div>

      <ChangePasswordDialog open={passwordDialogOpen} onOpenChange={setPasswordDialogOpen} />
    </div>
  );
}

function DepotProGate() {
  const { data: bootstrap, isLoading: loadingBootstrap, isError, refetch } = useBootstrapStatus();
  const hasToken = Boolean(getStoredSessionToken());
  const { data: currentUser, isLoading: loadingMe } = useCurrentUser(
    Boolean(bootstrap && !bootstrap.needsSetup && hasToken)
  );

  if (loadingBootstrap || (bootstrap && !bootstrap.needsSetup && hasToken && loadingMe)) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-6">
        <div className="w-full max-w-md space-y-3">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-44 w-full rounded-lg" />
        </div>
      </div>
    );
  }

  if (isError || !bootstrap) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-6">
        <div className="space-y-4 text-center">
          <p className="text-sm text-destructive">
            Impossible de joindre le moteur local SQLite.
          </p>
          <Button variant="outline" onClick={() => void refetch()}>
            Réessayer
          </Button>
        </div>
      </div>
    );
  }

  if (bootstrap.needsSetup) {
    return <OnboardingWizard />;
  }

  if (!currentUser) {
    return <LoginView bootstrap={bootstrap} />;
  }

  return <AuthenticatedWorkspace user={currentUser} bootstrap={bootstrap} />;
}

export default function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <DepotProGate />
          <Toaster position="bottom-right" richColors />
        </QueryClientProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}
