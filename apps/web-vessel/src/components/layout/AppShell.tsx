'use client';

import { ReactNode, useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { LayoutDashboard, FileText, Settings, Users, Ship, Bell, Menu, LogOut, Search, Loader2, X, User } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ThemeToggle } from '@/components/ui/theme-toggle';

interface AppShellProps {
  children: ReactNode;
}

export function AppShell({ children }: AppShellProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);
  const [isLoggingOut, setIsLoggingOut] = useState(false);

  // Close mobile sidebar on route change
  useEffect(() => {
    setIsMobileSidebarOpen(false);
  }, [pathname]);

  const handleLogout = async (e: React.MouseEvent) => {
    e.preventDefault();
    setIsLoggingOut(true);
    
    try {
      await fetch('http://localhost:3003/auth/logout', {
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
    { href: '/users', label: 'Users', icon: Users },
    { href: '/setup', label: 'Vessel Setup', icon: Ship },
    { href: '/settings', label: 'Settings', icon: Settings },
  ];

  return (
    <div className="min-h-screen bg-[#0a0a0c] text-foreground flex overflow-hidden font-sans selection:bg-indigo-500/30">
      
      {/* Mobile Sidebar Overlay */}
      {isMobileSidebarOpen && (
        <div 
          className="fixed inset-0 bg-black/60 backdrop-blur-sm z-40 md:hidden transition-opacity"
          onClick={() => setIsMobileSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={`fixed inset-y-0 left-0 z-50 flex flex-col bg-background/80 backdrop-blur-xl border-r border-border/60 shadow-2xl transition-all duration-300 ease-[cubic-bezier(0.2,0.8,0.2,1)]
          md:relative md:translate-x-0 ${isMobileSidebarOpen ? 'translate-x-0' : '-translate-x-full'} 
          ${isSidebarOpen ? 'w-[260px]' : 'md:w-[80px] w-[260px]'}`}
      >
        <div className="h-16 flex items-center px-4 border-b border-border/40 relative">
          {isSidebarOpen && (
            <span className="font-semibold text-[15px] tracking-wide whitespace-nowrap bg-clip-text text-transparent bg-gradient-to-r from-zinc-100 to-zinc-400">
              Cadetlabs
            </span>
          )}
          <Button 
            variant="ghost" 
            size="icon" 
            onClick={() => setIsMobileSidebarOpen(false)} 
            className="absolute right-2 md:hidden text-muted-foreground hover:text-foreground"
          >
            <X className="w-5 h-5" />
          </Button>
        </div>

        <div className="flex-1 overflow-y-auto py-6 px-3 space-y-1.5 custom-scrollbar">
          {navItems.map((item) => {
            const isActive = pathname === item.href || (item.href !== '/' && pathname.startsWith(item.href));
            return (
              <Link key={item.href} href={item.href} className="block group">
                <div className={`flex items-center px-3 py-2.5 rounded-xl transition-all duration-200 relative overflow-hidden
                  ${isActive 
                    ? 'bg-indigo-500/10 text-indigo-100 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] ring-1 ring-inset ring-indigo-500/20' 
                    : 'text-muted-foreground hover:text-foreground hover:bg-muted/40'}`}>
                  {isActive && (
                    <div className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-1/2 bg-indigo-500 rounded-r-full shadow-[0_0_8px_rgba(99,102,241,0.8)]" />
                  )}
                  <item.icon className={`w-[18px] h-[18px] shrink-0 z-10 transition-colors ${isActive ? 'text-indigo-400' : 'text-muted-foreground group-hover:text-foreground'}`} />
                  {isSidebarOpen && (
                    <span className="ml-3.5 font-medium text-[13px] z-10 whitespace-nowrap tracking-wide">{item.label}</span>
                  )}
                </div>
              </Link>
            );
          })}
        </div>

        <div className="p-4 border-t border-border/40 bg-background/50">
          <button 
            onClick={handleLogout}
            disabled={isLoggingOut}
            className="w-full flex items-center px-3 py-2.5 rounded-xl text-muted-foreground hover:text-red-400 hover:bg-red-500/10 hover:ring-1 hover:ring-inset hover:ring-red-500/20 transition-all duration-200 disabled:opacity-50 group"
          >
            {isLoggingOut ? (
              <Loader2 className="w-[18px] h-[18px] shrink-0 animate-spin text-red-400" />
            ) : (
              <LogOut className="w-[18px] h-[18px] shrink-0 group-hover:text-red-400 transition-colors" />
            )}
            {isSidebarOpen && <span className="ml-3.5 font-medium text-[13px]">Sign Out</span>}
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <div className="flex-1 flex flex-col h-screen overflow-hidden bg-gradient-to-br from-[#0a0a0c] to-[#121216]">
        {/* Top Header */}
        <header className="h-16 bg-background/60 backdrop-blur-xl border-b border-border/50 flex items-center justify-between px-4 lg:px-8 z-10 shrink-0 sticky top-0 shadow-sm">
          <div className="flex items-center gap-4">
            <Button variant="ghost" size="icon" onClick={() => setIsMobileSidebarOpen(true)} className="md:hidden text-muted-foreground hover:text-foreground hover:bg-muted/50 rounded-lg">
              <Menu className="w-5 h-5" />
            </Button>
            <Button variant="ghost" size="icon" onClick={() => setIsSidebarOpen(!isSidebarOpen)} className="hidden md:flex text-muted-foreground hover:text-foreground hover:bg-muted/50 rounded-lg transition-transform active:scale-95">
              <Menu className="w-5 h-5" />
            </Button>
            {/* Search */}
            <div className="hidden md:flex relative max-w-md w-64 group">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground group-focus-within:text-indigo-400 transition-colors" />
              <Input 
                placeholder="Search resources..." 
                className="pl-10 bg-card/50 border-border focus-visible:ring-1 focus-visible:ring-indigo-500/50 h-9 w-full text-[13px] rounded-xl shadow-inner placeholder:text-muted-foreground transition-all focus-visible:bg-card"
              />
            </div>
          </div>

          <div className="flex items-center space-x-5">
            <ThemeToggle />
            <Popover>
              <PopoverTrigger
                render={
                  <Button variant="ghost" size="icon" className="relative text-muted-foreground hover:text-foreground h-9 w-9 rounded-xl hover:bg-muted/50 transition-colors">
                    <Bell className="w-4 h-4" />
                    <span className="absolute top-2 right-2 w-2 h-2 rounded-full bg-indigo-500 ring-2 ring-zinc-950 shadow-[0_0_8px_rgba(99,102,241,0.8)]" />
                  </Button>
                }
              />
              <PopoverContent align="end" className="w-80 bg-card/95 backdrop-blur-xl border-border shadow-2xl rounded-2xl text-foreground p-0 overflow-hidden">
                <div className="p-4 border-b border-border/50 bg-background/50">
                  <h4 className="font-semibold text-[13px] tracking-wide text-foreground">Notifications</h4>
                </div>
                <div className="p-6 flex flex-col items-center justify-center text-center space-y-2">
                  <div className="w-10 h-10 rounded-full bg-indigo-500/10 flex items-center justify-center mb-1">
                    <Bell className="w-5 h-5 text-indigo-400" />
                  </div>
                  <p className="text-[13px] font-medium text-foreground">You're all caught up</p>
                  <p className="text-xs text-muted-foreground">No new alerts from shore.</p>
                </div>
              </PopoverContent>
            </Popover>

            <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-indigo-600 to-purple-600 p-[1px] shadow-lg cursor-pointer hover:shadow-indigo-500/25 transition-shadow">
              <div className="w-full h-full rounded-[11px] bg-card border border-white/10 flex items-center justify-center">
                <User className="w-4 h-4 text-foreground" />
              </div>
            </div>
          </div>
        </header>

        {/* Page Content */}
        <main className="flex-1 overflow-y-auto p-4 md:p-8 scroll-smooth custom-scrollbar relative">
          <div className="absolute inset-0 bg-[url('/noise.png')] opacity-[0.015] pointer-events-none mix-blend-overlay" />
          <div className="absolute top-[-20%] left-[-10%] w-[50%] h-[50%] bg-indigo-500/10 blur-[120px] rounded-full pointer-events-none" />
          <div className="max-w-[1400px] mx-auto min-h-full pb-12 relative z-10">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
