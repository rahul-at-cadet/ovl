'use client';

import { ReactNode, useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { LayoutDashboard, FileText, Settings, Users, Ship, Bell, Menu, LogOut, Loader2, X, User, AlertTriangle, MessageSquare, Clock, KeyRound } from 'lucide-react';
import { Button } from '@ovl/ui/components/button';
import { Popover, PopoverContent, PopoverTrigger } from '@ovl/ui/components/popover';
import { ThemeToggle } from '@ovl/ui/components/theme-toggle';
import { CadetlabsLogo } from '@/components/layout/CadetlabsLogo';
import { trpc } from '@/lib/trpc';
import { ChangePasswordDialog } from '@/components/ChangePasswordDialog';
import { API_ORIGIN } from '@/lib/api-origin';

interface AppShellProps {
  children: ReactNode;
}

// Turns "log-abstract.json" into "Log Abstract" for display — this
// bell is the only place in the vessel UI that needs a human-readable
// schema name, so a small inline formatter here beats a shared util
// with exactly one caller.
function schemaDisplayName(schemaName: string): string {
  return schemaName
    .replace(/\.json$/, '')
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

export function AppShell({ children }: AppShellProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [isChangePasswordOpen, setIsChangePasswordOpen] = useState(false);

  // Users administration is Master-only, matching the original app's own
  // route guard (ovl/web/vessel/src/App.tsx redirects a non-master away from
  // /users). Without this the nav offered every crew member a screen whose
  // actions the API would then refuse.
  const { data: me } = trpc.users.me.useQuery();
  const isMaster = (me?.role ?? '').toLowerCase() === 'master';

  const { data: notifications = [] } = trpc.notifications.list.useQuery(undefined, {
    refetchInterval: 60_000,
  });

  // Close mobile sidebar on route change
  useEffect(() => {
    setIsMobileSidebarOpen(false);
  }, [pathname]);

  const handleLogout = async (e: React.MouseEvent) => {
    e.preventDefault();
    setIsLoggingOut(true);
    
    try {
      await fetch(`${API_ORIGIN}/auth/logout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
      });
    } catch (err) {
      console.error('Logout request failed', err);
    } finally {
      setIsLoggingOut(false);
      router.push('/login');
    }
  };

  const navItems = [
    { href: '/', label: 'Dashboard', icon: LayoutDashboard },
    { href: '/reports', label: 'Reports', icon: FileText },
    ...(isMaster ? [{ href: '/users', label: 'Users', icon: Users }] : []),
    { href: '/setup', label: 'Vessel Setup', icon: Ship },
    { href: '/settings', label: 'Settings', icon: Settings },
  ];

  return (
    <div className="min-h-screen bg-background text-foreground flex overflow-hidden font-sans selection:bg-primary/30">
      {/* First thing in the tab order: without it, reaching page content by
          keyboard means tabbing past every sidebar link on every navigation. */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:top-3 focus:left-3 focus:z-50 focus:rounded-sm focus:bg-card focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-foreground focus:border focus:border-border focus:outline-none focus:ring-2 focus:ring-ring"
      >
        Skip to main content
      </a>

      {/* Mobile Sidebar Overlay */}
      {isMobileSidebarOpen && (
        <div 
          className="fixed inset-0 bg-foreground/40 z-40 md:hidden"
          onClick={() => setIsMobileSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={`fixed inset-y-0 left-0 z-50 flex flex-col bg-sidebar border-r border-sidebar-border transition-[width,transform] duration-200 ease-out
          md:relative md:translate-x-0 ${isMobileSidebarOpen ? 'translate-x-0' : '-translate-x-full'} 
          ${isSidebarOpen ? 'w-[260px]' : 'md:w-[80px] w-[260px]'}`}
      >
        <div className="h-14 flex items-center gap-2.5 px-4 border-b border-sidebar-border relative">
          <CadetlabsLogo className="h-6 w-6 shrink-0" />
          {(isSidebarOpen || isMobileSidebarOpen) && (
            <span className="font-semibold text-base tracking-wide whitespace-nowrap text-foreground">
              Cadetlabs
            </span>
          )}
          <Button 
            variant="ghost" 
            size="icon"
            aria-label="Close navigation menu"
            onClick={() => setIsMobileSidebarOpen(false)}
            className="absolute right-2 md:hidden text-muted-foreground hover:text-foreground"
          >
            <X className="w-5 h-5" />
          </Button>
        </div>

        <div className="flex-1 overflow-y-auto py-3 px-2 space-y-0.5">
          {navItems.map((item) => {
            const isActive = pathname === item.href || (item.href !== '/' && pathname.startsWith(item.href));
            return (
              <Link key={item.href} href={item.href} className="block group">
                <div className={`flex items-center px-3 min-h-12 rounded-sm transition-colors relative
                  ${isActive
                    ? 'bg-sidebar-accent text-foreground font-semibold'
                    : 'text-muted-foreground hover:text-foreground hover:bg-sidebar-accent/60'}`}>
                  {isActive && (
                    <div className="absolute left-0 inset-y-0 w-[2px] bg-primary" aria-hidden="true" />
                  )}
                  <item.icon className={`w-4 h-4 shrink-0 ${isActive ? 'text-primary' : 'text-muted-foreground group-hover:text-foreground'}`} />
                  {(isSidebarOpen || isMobileSidebarOpen) && (
                    <span className="ml-3 text-[0.8125rem] font-medium whitespace-nowrap">{item.label}</span>
                  )}
                </div>
              </Link>
            );
          })}
        </div>

        <div className="p-4 border-t border-border bg-card">
          <button 
            onClick={handleLogout}
            disabled={isLoggingOut}
            className="w-full flex items-center px-3 min-h-12 rounded-sm text-muted-foreground hover:text-status-critical hover:bg-status-critical/10 hover:ring-1 hover:ring-inset hover:ring-status-critical/20 transition-all duration-200 disabled:opacity-50 group"
          >
            {isLoggingOut ? (
              <Loader2 className="w-[18px] h-[18px] shrink-0 animate-spin text-status-critical" />
            ) : (
              <LogOut className="w-[18px] h-[18px] shrink-0 group-hover:text-status-critical transition-colors" />
            )}
            {(isSidebarOpen || isMobileSidebarOpen) && <span className="ml-3.5 font-medium text-sm">Sign Out</span>}
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <div className="flex-1 flex flex-col h-screen overflow-hidden">
        {/* Top Header */}
        <header className="h-14 bg-background border-b border-border flex items-center justify-between px-4 lg:px-6 z-10 shrink-0 sticky top-0">
          <div className="flex items-center gap-4">
            <Button variant="ghost" size="icon" aria-label="Open navigation menu" onClick={() => setIsMobileSidebarOpen(true)} className="md:hidden text-muted-foreground hover:text-foreground">
              <Menu className="w-5 h-5" />
            </Button>
            <Button variant="ghost" size="icon" aria-label={isSidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'} aria-expanded={isSidebarOpen} onClick={() => setIsSidebarOpen(!isSidebarOpen)} className="hidden md:flex text-muted-foreground hover:text-foreground">
              <Menu className="w-5 h-5" />
            </Button>
          </div>

          <div className="flex items-center gap-1">
            <ThemeToggle />
            {/* Base UI's Popover.Root renders no wrapping element of its own —
                it injects small focus-guard elements inline at this exact
                nesting level when open. Left unwrapped, those become extra
                flex children of this space-x-5 row and get margined like any
                other child, visibly shifting later siblings. A plain div
                contains them instead. */}
            <div>
            <Popover>
              <PopoverTrigger
                render={
                  <Button variant="ghost" size="icon" aria-label={notifications.length > 0 ? `Notifications, ${notifications.length} unread` : 'Notifications'} className="relative text-muted-foreground hover:text-foreground">
                    <Bell className="w-4 h-4" />
                    {notifications.length > 0 && (
                      <span className="absolute top-1 right-1 min-w-[18px] h-[18px] px-1 rounded-sm bg-status-critical ring-2 ring-background text-xs font-semibold text-background flex items-center justify-center leading-none tabular-nums">
                        {notifications.length > 9 ? '9+' : notifications.length}
                      </span>
                    )}
                  </Button>
                }
              />
              <PopoverContent align="end" className="w-80 max-h-[420px] flex flex-col bg-popover border-border rounded-sm text-popover-foreground p-0 overflow-hidden">
                <div className="p-4 border-b border-border bg-card shrink-0">
                  <h4 className="font-semibold text-sm tracking-wide text-foreground">Notifications</h4>
                </div>
                {notifications.length === 0 ? (
                  <div className="p-6 flex flex-col items-center justify-center text-center space-y-2">
                    <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center mb-1">
                      <Bell className="w-5 h-5 text-primary" />
                    </div>
                    <p className="text-sm font-medium text-foreground">You're all caught up</p>
                    <p className="text-xs text-muted-foreground">No new alerts from shore.</p>
                  </div>
                ) : (
                  <div className="flex-1 overflow-y-auto">
                    {notifications.map((n) => {
                      const Icon = n.category === 'invalidated' ? AlertTriangle : n.category === 'overdue' ? Clock : MessageSquare;
                      const color = n.category === 'invalidated' ? 'text-status-critical' : n.category === 'overdue' ? 'text-status-critical' : 'text-status-warn';
                      return (
                        <button
                          key={n.id}
                          onClick={() => router.push(`/reports/${n.reportId}`)}
                          className="w-full flex gap-3 items-start px-4 py-3 border-b border-border last:border-0 hover:bg-muted transition-colors text-left"
                        >
                          <Icon className={`w-4 h-4 shrink-0 mt-0.5 ${color}`} />
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-foreground truncate">{schemaDisplayName(n.schemaName)} · {n.eventType}</p>
                            <p className="text-xs text-muted-foreground truncate">{n.message}</p>
                            <p className="text-xs text-muted-foreground mt-1">{new Date(n.at).toLocaleString()}</p>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </PopoverContent>
            </Popover>
            </div>

            <div>
            <Popover>
              <PopoverTrigger
                render={
                  <button aria-label="Account menu" className="size-12 rounded-sm flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-surface-hover transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    <User className="w-5 h-5" />
                  </button>
                }
              />
              <PopoverContent align="end" className="w-56 bg-popover border-border rounded-sm text-popover-foreground p-0 overflow-hidden">
                {me && (
                  <div className="px-3 py-2.5 border-b border-border">
                    <p className="text-sm font-medium text-foreground truncate">{me.username}</p>
                    <p className="text-xs text-muted-foreground truncate capitalize">{me.role}</p>
                  </div>
                )}
                <button
                  onClick={() => setIsChangePasswordOpen(true)}
                  className="w-full flex items-center px-3 py-2.5 text-sm text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                >
                  <KeyRound className="w-4 h-4 mr-2 shrink-0" />
                  Change password&hellip;
                </button>
                <button
                  onClick={handleLogout}
                  disabled={isLoggingOut}
                  className="w-full flex items-center px-3 py-2.5 text-sm text-muted-foreground hover:text-status-critical hover:bg-status-critical/10 transition-colors disabled:opacity-50"
                >
                  {isLoggingOut ? (
                    <Loader2 className="w-4 h-4 mr-2 shrink-0 animate-spin" />
                  ) : (
                    <LogOut className="w-4 h-4 mr-2 shrink-0" />
                  )}
                  Sign Out
                </button>
              </PopoverContent>
            </Popover>
            </div>
          </div>
        </header>

        {/* Page Content */}
        <main id="main-content" tabIndex={-1} className="flex-1 overflow-y-auto p-4 md:p-8 xl:pb-0 scroll-smooth relative">
          <div className="max-w-[1400px] mx-auto min-h-full pb-12 xl:pb-0 relative z-10">
            {children}
          </div>
        </main>
      </div>
      <ChangePasswordDialog open={isChangePasswordOpen} onOpenChange={setIsChangePasswordOpen} />
    </div>
  );
}
