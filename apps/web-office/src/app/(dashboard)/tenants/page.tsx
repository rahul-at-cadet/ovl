'use client';

import { useState } from 'react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@ovl/ui/components/card';
import { Button } from '@ovl/ui/components/button';
import { Input } from '@ovl/ui/components/input';
import { Label } from '@ovl/ui/components/label';
import { StatusBadge } from '@ovl/ui/components/status-badge';
import { CopyField } from '@ovl/ui/components/copy-field';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@ovl/ui/components/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@ovl/ui/components/dropdown-menu';
import {
  Building2,
  Plus,
  Search,
  ShieldCheck,
  MoreHorizontal,
  PauseCircle,
  PlayCircle,
  UserPlus,
  Trash2,
  ArrowUpCircle,
  AlertTriangle,
  Eye,
  EyeOff,
} from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { trpc } from '@/lib/trpc';

/**
 * Platform tenant administration — the super admin's screen.
 *
 * This is the top of the hierarchy the rest of the office app sits inside: a
 * super admin creates a tenant and its first admin here, that admin creates the
 * tenant's office users, and those users register its vessels. Every other page
 * in this app operates *within* one tenant; this is the only one that sees
 * across them.
 */

/** Tenant lifecycle → the status vocabulary StatusBadge already speaks. */
const STATUS_ROLE = {
  active: 'ok',
  provisioning: 'info',
  suspended: 'warn',
  archived: 'neutral',
} as const;

export default function TenantsPage() {
  const [searchQuery, setSearchQuery] = useState('');

  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newSlug, setNewSlug] = useState('');
  const [newAdminEmail, setNewAdminEmail] = useState('');
  const [created, setCreated] = useState<{
    slug: string;
    admin: { username: string; temporaryPassword: string } | null;
    adminError: string | null;
  } | null>(null);

  const [adminTarget, setAdminTarget] = useState<{ slug: string; name: string } | null>(null);
  const [adminUsername, setAdminUsername] = useState('');
  const [adminCreated, setAdminCreated] = useState<{
    username: string;
    temporaryPassword: string;
  } | null>(null);

  const [destroyTarget, setDestroyTarget] = useState<{ slug: string; name: string } | null>(null);
  const [destroyConfirmation, setDestroyConfirmation] = useState('');

  const utils = trpc.useUtils();
  const queryClient = useQueryClient();
  const { data: capabilities } = trpc.tenants.capabilities.useQuery();
  const isSuperAdmin = capabilities?.isSuperAdmin === true;

  const {
    data: tenants = [],
    isFetching: isFetchingTenants,
    isSuccess: tenantsLoaded,
    error: tenantsError,
  } = trpc.tenants.list.useQuery(undefined, {
    // The list is super-admin only; querying it as anyone else just produces a
    // 403 toast on a page that is already telling them they lack access.
    enabled: isSuperAdmin,
  });

  // Nothing may claim the fleet is empty until the list has actually arrived.
  //
  // This is the "No tenants yet" report, and the cause was a render state
  // rather than any missing data. React Query derives `isLoading` as
  // `isPending && isFetching`, so a query held back by `enabled: false` is
  // *pending but not loading* — and this query is disabled until
  // `capabilities` comes back and says the viewer is a super admin. In that
  // window the old code fell straight past its loading branch to the empty
  // one and rendered "No tenants yet." to a platform admin whose tenants were
  // all present and about to load.
  //
  // Keyed on `isSuccess` instead: the empty state now requires the request to
  // have completed and genuinely returned nothing.
  const tenantsPending = !capabilities || (isSuperAdmin && !tenantsLoaded && !tenantsError);
  const isLoading = tenantsPending || isFetchingTenants;

  const provisionMutation = trpc.tenants.provision.useMutation({
    // The result — including a one-time password — is rendered inline in the
    // dialog, so a toast would say the same thing twice.
    meta: { silentError: true },
    onSuccess: (data) => {
      setCreated({ slug: data.slug, admin: data.admin, adminError: data.adminError });
      utils.tenants.list.invalidate();
    },
  });

  const createAdminMutation = trpc.tenants.createAdmin.useMutation({
    meta: { silentError: true },
    onSuccess: (data) => setAdminCreated(data),
  });

  const setStatusMutation = trpc.tenants.setStatus.useMutation({
    meta: { errorTitle: "Couldn't change that tenant's status" },
    onSuccess: () => utils.tenants.list.invalidate(),
  });

  const destroyMutation = trpc.tenants.destroy.useMutation({
    meta: { errorTitle: "Couldn't destroy that tenant" },
    onSuccess: () => {
      utils.tenants.list.invalidate();
      setDestroyTarget(null);
      setDestroyConfirmation('');
    },
  });

  const migrateAllMutation = trpc.tenants.migrateAll.useMutation({
    meta: { errorTitle: "Couldn't run tenant migrations" },
    onSuccess: () => utils.tenants.list.invalidate(),
  });

  // Viewing a tenant changes which schema every other screen reads, so the
  // whole tRPC cache has to go — not just this page's queries.
  //
  // Removed rather than invalidated, and the difference matters: invalidation
  // keeps serving the old rows until a fresh answer replaces them, so every
  // screen would show the previous tenant's data in the meantime — and after
  // stopping a view there is no fresh answer at all, because a super admin
  // with no tenant gets FORBIDDEN from every tenant-scoped procedure and
  // React Query keeps the last successful data on error.
  const resetTenantScopedCache = () => {
    queryClient.removeQueries();
    // This page's own list is not tenant-scoped and is what the operator is
    // looking at, so put it back immediately rather than leaving a blank table.
    void utils.tenants.list.refetch();
    void utils.tenants.capabilities.refetch();
  };

  const viewAsMutation = trpc.tenants.viewAs.useMutation({
    meta: { errorTitle: "Couldn't switch to that tenant" },
    onSuccess: resetTenantScopedCache,
  });

  const stopViewingMutation = trpc.tenants.stopViewing.useMutation({
    meta: { errorTitle: "Couldn't stop viewing that tenant" },
    onSuccess: resetTenantScopedCache,
  });

  const migrateTenantMutation = trpc.tenants.migrateTenant.useMutation({
    meta: { errorTitle: "Couldn't migrate that tenant" },
    onSuccess: () => utils.tenants.list.invalidate(),
  });

  const filtered = tenants.filter(
    (t) =>
      t.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      t.slug.toLowerCase().includes(searchQuery.toLowerCase()),
  );

  const pendingCount = tenants.filter((t) => t.pendingMigrations.length > 0).length;
  const driftedCount = tenants.filter((t) => t.driftedMigrations.length > 0).length;

  function closeCreate() {
    setIsCreateOpen(false);
    setCreated(null);
    setNewName('');
    setNewSlug('');
    setNewAdminEmail('');
    provisionMutation.reset();
  }

  function closeAdmin() {
    setAdminTarget(null);
    setAdminCreated(null);
    setAdminUsername('');
    createAdminMutation.reset();
  }

  // Tenancy switched off entirely: say so rather than render an empty table
  // that looks like "you have no customers".
  if (capabilities && !capabilities.tenancyEnabled) {
    return (
      <div className="space-y-6">
        <PageHeading />
        <Card className="bg-card border-border rounded-md">
          <CardContent className="py-12 text-center">
            <Building2 className="w-8 h-8 mx-auto text-muted-foreground mb-3" />
            <p className="text-sm font-medium text-foreground">Multi-tenancy is not enabled</p>
            <p className="text-xs text-muted-foreground mt-1.5 max-w-md mx-auto">
              This deployment runs against a single shared schema. Set{' '}
              <code className="text-foreground">MULTI_TENANCY_ENABLED</code> and restart the office
              API to administer tenants here.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (capabilities && !isSuperAdmin) {
    return (
      <div className="space-y-6">
        <PageHeading />
        <Card className="bg-card border-border rounded-md">
          <CardContent className="py-12 text-center">
            <ShieldCheck className="w-8 h-8 mx-auto text-muted-foreground mb-3" />
            <p className="text-sm font-medium text-foreground">Platform super admin required</p>
            <p className="text-xs text-muted-foreground mt-1.5 max-w-md mx-auto">
              Tenant administration sits above your own organisation, so it is limited to platform
              super admins. Your office admin can manage users and vessels for this tenant.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* min-w-0 on both halves, and the actions wrap rather than forcing the
          row wider than the page. Without it the heading refused to shrink,
          the search field held its fixed width, and the whole body scrolled
          horizontally with the primary action clipped off the right edge. */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 min-w-0">
        <div className="min-w-0">
          <PageHeading />
        </div>
        <div className="flex flex-wrap gap-3 w-full md:w-auto min-w-0">
          <div className="relative flex-1 min-w-[12rem] md:w-72 md:flex-none">
            <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search by name or slug..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9 h-9 text-sm w-full"
            />
          </div>
          <Button
            onClick={() => setIsCreateOpen(true)}
            disabled={!capabilities?.canProvision}
            className="bg-primary hover:bg-primary/90 text-primary-foreground rounded-md h-9 text-sm font-semibold shadow-sm shrink-0 whitespace-nowrap"
          >
            <Plus className="w-4 h-4 mr-2" />
            New Tenant
          </Button>
        </div>
      </div>

      {/* Provisioning needs an administrative database role. Without it the
          list still works, so this is a notice rather than an empty state. */}
      {capabilities && !capabilities.canProvision && (
        <Card className="bg-card border-status-warn/30 rounded-md">
          <CardContent className="py-3 flex items-start gap-2.5">
            <AlertTriangle className="w-4 h-4 text-status-warn shrink-0 mt-0.5" />
            <p className="text-xs text-muted-foreground">
              <span className="text-foreground font-medium">Provisioning is unavailable.</span>{' '}
              Creating, suspending and migrating tenants needs{' '}
              <code className="text-foreground">ADMIN_DATABASE_URL</code> — a role that may CREATE
              SCHEMA and CREATE ROLE. Tenants can be viewed but not changed.
            </p>
          </CardContent>
        </Card>
      )}

      {(pendingCount > 0 || driftedCount > 0) && (
        <Card className="bg-card border-border rounded-md">
          <CardContent className="py-3 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-start gap-2.5">
              <ArrowUpCircle className="w-4 h-4 text-status-attention shrink-0 mt-0.5" />
              <p className="text-xs text-muted-foreground">
                {pendingCount > 0 && (
                  <>
                    <span className="text-foreground font-medium">
                      {pendingCount} tenant{pendingCount === 1 ? '' : 's'} behind on migrations.
                    </span>{' '}
                    A tenant whose schema is behind will fail on the parts of sync that need the
                    missing tables.{' '}
                  </>
                )}
                {driftedCount > 0 && (
                  <span className="text-status-critical">
                    {driftedCount} tenant{driftedCount === 1 ? ' has' : 's have'} drifted migrations
                    — an applied file changed after the fact, and no further migration will run
                    until that is resolved by hand.
                  </span>
                )}
              </p>
            </div>
            {pendingCount > 0 && (
              <Button
                variant="outline"
                className="h-8 text-xs shrink-0"
                disabled={!capabilities?.canProvision || migrateAllMutation.isPending}
                onClick={() => migrateAllMutation.mutate()}
              >
                {migrateAllMutation.isPending ? 'Migrating...' : 'Migrate all tenants'}
              </Button>
            )}
          </CardContent>
        </Card>
      )}

      <Card className="bg-card border-border shadow-sm rounded-md overflow-hidden">
        <CardHeader className="border-b border-border pb-4">
          <CardTitle className="text-sm font-semibold tracking-tight text-foreground">
            Tenants
          </CardTitle>
          <CardDescription className="text-xs text-muted-foreground">
            Each tenant owns an isolated Postgres schema, its own office users, and its own vessels.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left text-muted-foreground">
              <thead className="text-xs text-muted-foreground uppercase tracking-wider bg-card border-b border-border">
                <tr>
                  <th scope="col" className="px-4 py-2 font-semibold">Tenant</th>
                  <th scope="col" className="hidden md:table-cell px-4 py-2 font-semibold">Schema</th>
                  <th scope="col" className="px-4 py-2 font-semibold">Status</th>
                  <th scope="col" className="px-4 py-2 font-semibold">Migrations</th>
                  <th scope="col" className="px-4 py-2 text-right font-semibold">Manage</th>
                </tr>
              </thead>
              <tbody>
                {isLoading ? (
                  <tr>
                    <td colSpan={5} className="px-6 py-12 text-center text-muted-foreground">
                      Loading tenants...
                    </td>
                  </tr>
                ) : tenantsError ? (
                  /* A failed request is not an empty fleet.
                   *
                   * `data` defaults to [] here, so before this branch existed
                   * every error — a 403, a dropped connection, a query that
                   * threw — rendered as "No tenants yet.", which is a claim
                   * about the world rather than a report about the request. It
                   * sent at least one person looking for a missing tenant that
                   * was never missing. */
                  <tr>
                    <td colSpan={5} className="px-6 py-12 text-center">
                      <p className="text-sm font-medium text-status-critical">
                        Couldn&apos;t load tenants
                      </p>
                      <p className="text-xs text-muted-foreground mt-1">{tenantsError.message}</p>
                      <Button
                        variant="outline"
                        size="sm"
                        className="mt-3"
                        onClick={() => utils.tenants.list.invalidate()}
                      >
                        Try again
                      </Button>
                    </td>
                  </tr>
                ) : filtered.length > 0 ? (
                  filtered.map((t) => {
                    const behind = t.pendingMigrations.length;
                    const drifted = t.driftedMigrations.length;
                    return (
                      <tr key={t.tenantId} className="border-b border-border last:border-0 hover:bg-muted/50">
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2.5">
                            <Building2 className="w-4 h-4 text-muted-foreground shrink-0" />
                            <div className="min-w-0">
                              <p className="text-sm font-medium text-foreground truncate">{t.name}</p>
                              <p className="text-xs text-muted-foreground truncate">{t.slug}</p>
                            </div>
                            {capabilities?.viewing?.slug === t.slug && (
                              <StatusBadge role="info" label="Viewing" size="sm" showIcon={false} />
                            )}
                          </div>
                        </td>
                        <td className="hidden md:table-cell px-4 py-3">
                          <code className="text-xs text-muted-foreground">{t.schemaName}</code>
                        </td>
                        <td className="px-4 py-3">
                          <StatusBadge
                            role={STATUS_ROLE[t.status as keyof typeof STATUS_ROLE] ?? 'neutral'}
                            label={t.status.charAt(0).toUpperCase() + t.status.slice(1)}
                            size="sm"
                          />
                        </td>
                        <td className="px-4 py-3">
                          {drifted > 0 ? (
                            <StatusBadge role="critical" label={`${drifted} drifted`} size="sm" />
                          ) : behind > 0 ? (
                            <StatusBadge role="attention" label={`${behind} pending`} size="sm" />
                          ) : (
                            <StatusBadge role="ok" label="Up to date" size="sm" />
                          )}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <DropdownMenu>
                            <DropdownMenuTrigger
                              render={
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-8 w-8"
                                  aria-label={`Manage ${t.name}`}
                                />
                              }
                            >
                              <MoreHorizontal className="w-4 h-4" />
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              {capabilities?.viewing?.slug === t.slug ? (
                                <DropdownMenuItem
                                  onClick={() => stopViewingMutation.mutate()}
                                >
                                  <EyeOff className="w-4 h-4 mr-2" />
                                  Stop viewing
                                </DropdownMenuItem>
                              ) : (
                                <DropdownMenuItem
                                  onClick={() => viewAsMutation.mutate({ slug: t.slug })}
                                >
                                  <Eye className="w-4 h-4 mr-2" />
                                  View this tenant&apos;s data
                                </DropdownMenuItem>
                              )}
                              <DropdownMenuItem
                                disabled={!capabilities?.canProvision}
                                onClick={() => setAdminTarget({ slug: t.slug, name: t.name })}
                              >
                                <UserPlus className="w-4 h-4 mr-2" />
                                Add office admin
                              </DropdownMenuItem>
                              {behind > 0 && (
                                <DropdownMenuItem
                                  disabled={!capabilities?.canProvision}
                                  onClick={() => migrateTenantMutation.mutate({ slug: t.slug })}
                                >
                                  <ArrowUpCircle className="w-4 h-4 mr-2" />
                                  Run {behind} pending migration{behind === 1 ? '' : 's'}
                                </DropdownMenuItem>
                              )}
                              {t.status === 'active' ? (
                                <DropdownMenuItem
                                  disabled={!capabilities?.canProvision}
                                  onClick={() =>
                                    setStatusMutation.mutate({ slug: t.slug, status: 'suspended' })
                                  }
                                >
                                  <PauseCircle className="w-4 h-4 mr-2" />
                                  Suspend
                                </DropdownMenuItem>
                              ) : (
                                <DropdownMenuItem
                                  disabled={!capabilities?.canProvision}
                                  onClick={() =>
                                    setStatusMutation.mutate({ slug: t.slug, status: 'active' })
                                  }
                                >
                                  <PlayCircle className="w-4 h-4 mr-2" />
                                  Reactivate
                                </DropdownMenuItem>
                              )}
                              <DropdownMenuItem
                                disabled={!capabilities?.canProvision}
                                onClick={() => setDestroyTarget({ slug: t.slug, name: t.name })}
                                className="text-status-critical"
                              >
                                <Trash2 className="w-4 h-4 mr-2" />
                                Destroy
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </td>
                      </tr>
                    );
                  })
                ) : (
                  <tr>
                    <td colSpan={5} className="px-6 py-12 text-center text-muted-foreground">
                      {tenants.length === 0 ? 'No tenants yet.' : 'No tenants match that search.'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* Create tenant */}
      <Dialog open={isCreateOpen} onOpenChange={(open) => (open ? setIsCreateOpen(true) : closeCreate())}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{created ? 'Tenant created' : 'New tenant'}</DialogTitle>
          </DialogHeader>

          {!created ? (
            <div className="space-y-4 py-2">
              <div className="space-y-2">
                <Label htmlFor="tenant-name">Organisation name</Label>
                <Input
                  id="tenant-name"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="Northstar Shipping"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="tenant-slug">Slug</Label>
                <Input
                  id="tenant-slug"
                  value={newSlug}
                  onChange={(e) => setNewSlug(e.target.value)}
                  placeholder="Derived from the name when left blank"
                />
                <p className="text-xs text-muted-foreground">
                  Becomes the Postgres schema and role name, and cannot be changed afterwards.
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="tenant-admin">First office admin (optional)</Label>
                <Input
                  id="tenant-admin"
                  type="email"
                  value={newAdminEmail}
                  onChange={(e) => setNewAdminEmail(e.target.value)}
                  placeholder="admin@northstar.example"
                />
                <p className="text-xs text-muted-foreground">
                  This account can then create the rest of the tenant&apos;s office users and
                  register its vessels. You can also add one later.
                </p>
              </div>
              {provisionMutation.error && (
                <p className="text-xs text-status-critical">{provisionMutation.error.message}</p>
              )}
            </div>
          ) : (
            <div className="space-y-4 py-2">
              <p className="text-sm text-foreground">
                Tenant <span className="font-medium">{created.slug}</span> is provisioned and
                active.
              </p>
              {created.admin ? (
                <div className="bg-muted/50 border border-border rounded-md p-4 space-y-3">
                  <div>
                    <p className="text-xs uppercase tracking-wider text-muted-foreground font-medium">
                      Admin
                    </p>
                    <p className="text-sm text-foreground">{created.admin.username}</p>
                  </div>
                  <div className="space-y-2">
                    <p className="text-sm text-muted-foreground">Temporary password (reveal once):</p>
                    <CopyField value={created.admin.temporaryPassword} />
                  </div>
                  <p className="text-xs text-status-warn/90">
                    Copy this now — it is not shown again.
                  </p>
                </div>
              ) : created.adminError ? (
                // Provisioning succeeded and admin creation did not. Said
                // plainly, because retrying the whole form would now collide
                // with a slug that already exists.
                <div className="bg-muted/50 border border-status-warn/30 rounded-md p-4">
                  <p className="text-xs text-status-warn">
                    The tenant was created, but its first admin was not:{' '}
                    {created.adminError}
                  </p>
                  <p className="text-xs text-muted-foreground mt-2">
                    Add one from the tenant&apos;s menu — do not create the tenant again.
                  </p>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  No admin was created. Add one from the tenant&apos;s menu when ready.
                </p>
              )}
            </div>
          )}

          <DialogFooter>
            {!created ? (
              <>
                <Button variant="outline" onClick={closeCreate}>
                  Cancel
                </Button>
                <Button
                  disabled={!newName.trim() || provisionMutation.isPending}
                  onClick={() =>
                    provisionMutation.mutate({
                      name: newName.trim(),
                      ...(newSlug.trim() ? { slug: newSlug.trim() } : {}),
                      ...(newAdminEmail.trim() ? { adminEmail: newAdminEmail.trim() } : {}),
                    })
                  }
                >
                  {provisionMutation.isPending ? 'Provisioning...' : 'Create tenant'}
                </Button>
              </>
            ) : (
              <Button onClick={closeCreate}>Done</Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add an office admin to an existing tenant */}
      <Dialog open={adminTarget !== null} onOpenChange={(open) => !open && closeAdmin()}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {adminCreated ? 'Admin created' : `Add an office admin to ${adminTarget?.name ?? ''}`}
            </DialogTitle>
          </DialogHeader>

          {!adminCreated ? (
            <div className="space-y-4 py-2">
              <div className="space-y-2">
                <Label htmlFor="admin-username">Email</Label>
                <Input
                  id="admin-username"
                  type="email"
                  value={adminUsername}
                  onChange={(e) => setAdminUsername(e.target.value)}
                  placeholder="admin@example.com"
                />
              </div>
              {createAdminMutation.error && (
                <p className="text-xs text-status-critical">{createAdminMutation.error.message}</p>
              )}
            </div>
          ) : (
            <div className="space-y-3 py-2">
              <p className="text-sm text-foreground">{adminCreated.username}</p>
              <div className="space-y-2">
                <p className="text-sm text-muted-foreground">Temporary password (reveal once):</p>
                <CopyField value={adminCreated.temporaryPassword} />
              </div>
              <p className="text-xs text-status-warn/90">Copy this now — it is not shown again.</p>
            </div>
          )}

          <DialogFooter>
            {!adminCreated ? (
              <>
                <Button variant="outline" onClick={closeAdmin}>
                  Cancel
                </Button>
                <Button
                  disabled={!adminUsername.trim() || createAdminMutation.isPending}
                  onClick={() =>
                    adminTarget &&
                    createAdminMutation.mutate({
                      slug: adminTarget.slug,
                      username: adminUsername.trim(),
                    })
                  }
                >
                  {createAdminMutation.isPending ? 'Creating...' : 'Create admin'}
                </Button>
              </>
            ) : (
              <Button onClick={closeAdmin}>Done</Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Destroy — irreversible, so it asks for the same confirmation string
          the service itself re-checks server-side. */}
      <Dialog
        open={destroyTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDestroyTarget(null);
            setDestroyConfirmation('');
          }
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Destroy {destroyTarget?.name}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <p className="text-sm text-muted-foreground">
              This drops the tenant&apos;s schema, its role, and every report, vessel and user in
              it. It cannot be undone and there is no soft delete — suspend the tenant instead if
              you may need the data back.
            </p>
            <div className="space-y-2">
              <Label htmlFor="destroy-confirm">
                Type{' '}
                <code className="text-foreground">drop tenant {destroyTarget?.slug}</code> to
                confirm
              </Label>
              <Input
                id="destroy-confirm"
                value={destroyConfirmation}
                onChange={(e) => setDestroyConfirmation(e.target.value)}
                autoComplete="off"
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setDestroyTarget(null);
                setDestroyConfirmation('');
              }}
            >
              Cancel
            </Button>
            <Button
              className="bg-status-critical hover:bg-status-critical/90 text-background"
              disabled={
                destroyConfirmation !== `drop tenant ${destroyTarget?.slug}` ||
                destroyMutation.isPending
              }
              onClick={() =>
                destroyTarget &&
                destroyMutation.mutate({
                  slug: destroyTarget.slug,
                  confirmation: destroyConfirmation,
                })
              }
            >
              {destroyMutation.isPending ? 'Destroying...' : 'Destroy tenant'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function PageHeading() {
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight text-foreground">Tenant Management</h1>
      <p className="text-muted-foreground mt-1.5 text-sm font-medium">
        Provision customer organisations and their first office admin.
      </p>
    </div>
  );
}
