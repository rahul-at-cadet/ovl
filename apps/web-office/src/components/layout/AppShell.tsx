'use client';

import { ReactNode, useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import Session, { signOut } from 'supertokens-auth-react/recipe/session';
import { LayoutDashboard, Database, Ship, Users, Settings, Bell, Menu, LogOut, Search, Sliders, AlertTriangle, MessageSquare, CloudDownload, Briefcase } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Sheet, SheetContent, SheetTrigger } from '@/components/ui/sheet';
import { ThemeToggle } from '@/components/ui/theme-toggle';
import { CadetlabsLogo } from '@/components/layout/CadetlabsLogo';
import { trpc } from '@/lib/trpc';

interface AppShellProps {
  children: ReactNode;
}

export function AppShell({ children }: AppShellProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [sessionChecked, setSessionChecked] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Session.doesSessionExist()
      .then((exists) => {
        if (cancelled) return;
        if (!exists) {
          router.replace('/login');
        } else {
          setSessionChecked(true);
        }
      })
      .catch((err) => {
        // If the session check itself fails (e.g. a transient refresh
        // error), fail safe to the login page rather than hanging on
        // "Checking session..." forever.
        console.error('Session check failed:', err);
        if (!cancelled) router.replace('/login');
      });
    return () => {
      cancelled = true;
    };
  }, [router]);

  const handleSignOut = async () => {
    await signOut();
    router.push('/login');
  };

  const utils = trpc.useUtils();
  const { data: notifications = [], isLoading } = trpc.notifications.list.useQuery(undefined, {
    enabled: sessionChecked,
    refetchInterval: 60_000,
  });
  const markReadMutation = trpc.notifications.markRead.useMutation({
    onSuccess: () => utils.notifications.list.invalidate(),
  });
  const unreadCount = notifications.filter((n) => !n.read).length;

  // Mirrors the original office NotificationPanel's own filter set —
  // there's no server-side "clear," this feed is a live projection
  // (see NotificationsService's own doc comment), so "Unread" is how a
  // user gets read items out of their way without deleting anything.
  const NOTIFICATION_FILTERS = ['All', 'Unread', 'Overdue', 'Remarks', 'Sync'] as const;
  type NotificationFilter = (typeof NOTIFICATION_FILTERS)[number];
  const [notificationFilter, setNotificationFilter] = useState<NotificationFilter>('All');
  const filteredNotifications = notifications.filter((n) => {
    switch (notificationFilter) {
      case 'All': return true;
      case 'Unread': return !n.read;
      case 'Overdue': return n.category === 'overdue';
      case 'Remarks': return n.category === 'remark';
      case 'Sync': return n.category === 'sync';
    }
  });

  function handleNotificationClick(n: (typeof notifications)[number]) {
    if (!n.read) markReadMutation.mutate({ ids: [n.id] });
    if (n.link?.section === 'reports' && n.link.reportId) {
      router.push(`/reports/${n.link.reportId}`);
    } else if (n.link?.section === 'vessels') {
      router.push('/vessels');
    } else if (n.link?.section === 'reports') {
      router.push('/reports');
    }
  }

  function handleMarkAllRead() {
    const unreadIds = notifications.filter((n) => !n.read).map((n) => n.id);
    if (unreadIds.length === 0) return;
    markReadMutation.mutate({ ids: unreadIds });
  }

  const navItems = [
    { href: '/', label: 'Fleet Overview', icon: LayoutDashboard },
    { href: '/reports', label: 'Incoming Reports', icon: Database },
    { href: '/commercial', label: 'Commercial', icon: Briefcase },
    { href: '/vessels', label: 'Vessel Management', icon: Ship },
    { href: '/configuration', label: 'Fleet Configuration', icon: Sliders },
    { href: '/users', label: 'Users & Roles', icon: Users },
    { href: '/settings', label: 'Global Settings', icon: Settings },
  ];

  if (!sessionChecked) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center text-muted-foreground text-sm">
        Checking session...
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background text-foreground flex overflow-hidden">
      {/* Sidebar */}
      <aside
        className={`h-screen bg-card border-r border-border flex flex-col relative z-20 shrink-0 hidden md:flex transition-all duration-200 ${isSidebarOpen ? 'w-[260px]' : 'w-[70px]'}`}
      >
        <div className="h-16 flex items-center gap-2 px-4 border-b border-border/50">
          <CadetlabsLogo className="h-6 w-6 shrink-0" />
          {isSidebarOpen && (
            <span className="font-medium text-sm tracking-tight whitespace-nowrap text-foreground">
              Cadetlabs
            </span>
          )}
        </div>

        <div className="flex-1 overflow-y-auto py-6 px-3 space-y-1">
          {navItems.map((item) => {
            const isActive = pathname === item.href || (item.href !== '/' && pathname.startsWith(item.href));
            return (
              <Link 
                key={item.href} 
                href={item.href} 
                className={`flex items-center px-3 py-2 rounded-sm transition-colors relative group ${isActive ? 'bg-muted/80 text-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-muted/40'}`}
              >
                <item.icon className={`w-4 h-4 shrink-0 z-10 ${isActive ? 'text-foreground' : 'text-muted-foreground group-hover:text-foreground'}`} />
                {isSidebarOpen && (
                  <span className="ml-3 font-medium text-xs z-10 whitespace-nowrap tracking-wide">{item.label}</span>
                )}
              </Link>
            );
          })}
        </div>

        <div className="p-4 border-t border-border">
          <button onClick={handleSignOut} className="w-full flex items-center px-3 py-2.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors">
            <LogOut className="w-5 h-5 shrink-0" />
            {isSidebarOpen && <span className="ml-3 font-medium text-sm">Sign Out</span>}
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <div className="flex-1 flex flex-col h-screen overflow-hidden">
        {/* Top Header */}
        <header className="h-16 bg-card/50 backdrop-blur-md border-b border-border flex items-center justify-between px-4 lg:px-8 z-10 shrink-0">
          <div className="flex items-center flex-1">
            <Button variant="ghost" size="icon" onClick={() => setIsSidebarOpen(!isSidebarOpen)} className="hidden md:flex text-muted-foreground hover:text-foreground mr-4">
              <Menu className="w-5 h-5" />
            </Button>
            
            {/* Mobile Navigation */}
            <div className="md:hidden flex items-center">
              <Sheet>
                <SheetTrigger render={<Button variant="ghost" size="icon" className="text-muted-foreground hover:text-foreground mr-2 -ml-2" />}>
                  <Menu className="w-5 h-5" />
                </SheetTrigger>
                <SheetContent side="left" className="w-[260px] bg-card border-r border-border p-0 flex flex-col">
                  <div className="h-16 flex items-center gap-2 px-4 border-b border-border/50 shrink-0">
                    <CadetlabsLogo className="h-6 w-6 shrink-0" />
                    <span className="font-medium text-sm tracking-tight whitespace-nowrap text-foreground">
                      Cadetlabs
                    </span>
                  </div>
                  <div className="flex-1 overflow-y-auto py-6 px-3 space-y-1">
                    {navItems.map((item) => {
                      const isActive = pathname === item.href || (item.href !== '/' && pathname.startsWith(item.href));
                      return (
                        <Link 
                          key={item.href} 
                          href={item.href} 
                          className={`flex items-center px-3 py-2 rounded-sm transition-colors relative group ${isActive ? 'bg-muted/80 text-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-muted/40'}`}
                        >
                          <item.icon className={`w-4 h-4 shrink-0 z-10 ${isActive ? 'text-foreground' : 'text-muted-foreground group-hover:text-foreground'}`} />
                          <span className="ml-3 font-medium text-xs z-10 whitespace-nowrap tracking-wide">{item.label}</span>
                        </Link>
                      );
                    })}
                  </div>
                  <div className="p-4 border-t border-border mt-auto shrink-0">
                    <button onClick={handleSignOut} className="w-full flex items-center px-3 py-2.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors">
                      <LogOut className="w-5 h-5 shrink-0" />
                      <span className="ml-3 font-medium text-sm">Sign Out</span>
                    </button>
                  </div>
                </SheetContent>
              </Sheet>
            </div>

            {/* Mobile Title */}
            <div className="md:hidden flex items-center gap-2 mr-4">
               <CadetlabsLogo className="h-5 w-5 shrink-0" />
               <span className="font-bold tracking-tight">Cadetlabs</span>
            </div>

            <div className="hidden md:flex relative max-w-md w-full">
              <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input 
                placeholder="Search..." 
                className="pl-9 bg-card border-border focus-visible:ring-ring h-8 w-full text-sm rounded-sm"
              />
            </div>
          </div>

          <div className="flex items-center space-x-4">
            <ThemeToggle />
            <Popover>
              <PopoverTrigger
                render={
                  <Button variant="ghost" size="icon" className="relative text-muted-foreground hover:text-foreground h-8 w-8">
                    <Bell className="w-4 h-4" />
                    {unreadCount > 0 && (
                      <span className="absolute top-1 right-1 min-w-[14px] h-[14px] px-[3px] rounded-full bg-red-500 text-white text-xs font-bold flex items-center justify-center leading-none">
                        {unreadCount > 9 ? '9+' : unreadCount}
                      </span>
                    )}
                  </Button>
                }
              />
              <PopoverContent align="end" className="w-96 max-h-[480px] flex flex-col bg-card border-border text-foreground p-0 overflow-hidden">
                <div className="p-4 border-b border-border flex justify-between items-center shrink-0">
                  <h4 className="font-semibold text-sm">Fleet Alerts</h4>
                  <button
                    onClick={handleMarkAllRead}
                    disabled={unreadCount === 0}
                    className={`text-xs ${unreadCount === 0 ? 'text-muted-foreground cursor-default' : 'text-primary hover:underline cursor-pointer'}`}
                  >
                    Mark all read
                  </button>
                </div>
                <div className="flex gap-1.5 px-4 py-2 border-b border-border shrink-0 overflow-x-auto">
                  {NOTIFICATION_FILTERS.map((f) => (
                    <button
                      key={f}
                      onClick={() => setNotificationFilter(f)}
                      className={`px-2.5 h-6 rounded-full text-xs font-medium border whitespace-nowrap transition-colors ${
                        notificationFilter === f
                          ? 'border-primary bg-primary/10 text-primary'
                          : 'border-border text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      {f}
                    </button>
                  ))}
                </div>
                <div className="flex-1 overflow-y-auto">
                  {isLoading ? (
                    <p className="text-xs text-muted-foreground text-center py-8">Loading alerts...</p>
                  ) : filteredNotifications.length > 0 ? (
                    filteredNotifications.map((notification) => {
                      const Icon = notification.category === 'overdue' ? AlertTriangle : notification.category === 'remark' ? MessageSquare : CloudDownload;
                      const color = notification.category === 'overdue' ? 'text-red-400' : notification.category === 'remark' ? 'text-amber-400' : 'text-emerald-400';
                      return (
                        <button
                          key={notification.id}
                          onClick={() => handleNotificationClick(notification)}
                          className="w-full flex gap-3 items-start px-4 py-3 border-b border-border last:border-0 hover:bg-muted/40 transition-colors text-left"
                        >
                          <Icon className={`w-4 h-4 shrink-0 mt-0.5 ${color}`} />
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium truncate">{notification.title}</p>
                            <p className="text-xs text-muted-foreground truncate">{notification.message}</p>
                            <p className="text-xs text-muted-foreground mt-1">{new Date(notification.at).toLocaleString()}</p>
                          </div>
                          {!notification.read && <span className="w-2 h-2 rounded-full bg-primary shrink-0 mt-1.5" />}
                        </button>
                      );
                    })
                  ) : (
                    <p className="text-xs text-muted-foreground text-center py-8">
                      {notificationFilter === 'All' ? 'No new alerts' : 'Nothing here.'}
                    </p>
                  )}
                </div>
              </PopoverContent>
            </Popover>

            <Avatar className="h-8 w-8 border border-border">
              <AvatarImage src="" />
              <AvatarFallback className="bg-primary text-primary-foreground text-xs">AD</AvatarFallback>
            </Avatar>
          </div>
        </header>

        {/* Page Content */}
        <main className="flex-1 overflow-y-auto p-4 lg:p-8">
          <div className="max-w-7xl mx-auto min-h-full pb-10">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
