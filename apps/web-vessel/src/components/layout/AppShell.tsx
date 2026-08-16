'use client';

import { ReactNode, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LayoutDashboard, FileText, Settings, Users, Ship, Bell, Menu, LogOut, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

interface AppShellProps {
  children: ReactNode;
}

export function AppShell({ children }: AppShellProps) {
  const pathname = usePathname();
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);

  const navItems = [
    { href: '/', label: 'Dashboard', icon: LayoutDashboard },
    { href: '/reports', label: 'Reports', icon: FileText },
    { href: '/users', label: 'Users', icon: Users },
    { href: '/setup', label: 'Vessel Setup', icon: Ship },
    { href: '/settings', label: 'Settings', icon: Settings },
  ];

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex overflow-hidden">
      {/* Sidebar */}
      <aside
        className={`h-screen bg-zinc-900 border-r border-zinc-800 flex flex-col relative z-20 shrink-0 hidden md:flex transition-all duration-200 ${isSidebarOpen ? 'w-[260px]' : 'w-[70px]'}`}
      >
        <div className="h-14 flex items-center px-4 border-b border-zinc-800/50">
          <div className="p-1.5 bg-zinc-800 rounded-sm border border-zinc-700 mr-3 shrink-0">
            <Ship className="w-4 h-4 text-zinc-300" />
          </div>
          {isSidebarOpen && (
            <span className="font-medium text-sm tracking-tight whitespace-nowrap text-zinc-100">
              Vessel Edge
            </span>
          )}
        </div>

        <div className="flex-1 overflow-y-auto py-6 px-3 space-y-1">
          {navItems.map((item) => {
            const isActive = pathname === item.href || (item.href !== '/' && pathname.startsWith(item.href));
            return (
              <Link key={item.href} href={item.href} className="block">
                <div className={`flex items-center px-3 py-2 rounded-sm transition-colors relative group ${isActive ? 'bg-zinc-800/80 text-zinc-100' : 'text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/40'}`}>
                  <item.icon className={`w-4 h-4 shrink-0 z-10 ${isActive ? 'text-zinc-100' : 'text-zinc-500 group-hover:text-zinc-300'}`} />
                  {isSidebarOpen && (
                    <span className="ml-3 font-medium text-xs z-10 whitespace-nowrap tracking-wide">{item.label}</span>
                  )}
                </div>
              </Link>
            );
          })}
        </div>

        <div className="p-4 border-t border-zinc-800">
          <Link href="/login" className="flex items-center px-3 py-2.5 rounded-lg text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/50 transition-colors">
            <LogOut className="w-5 h-5 shrink-0" />
            {isSidebarOpen && <span className="ml-3 font-medium text-sm">Sign Out</span>}
          </Link>
        </div>
      </aside>

      {/* Main Content */}
      <div className="flex-1 flex flex-col h-screen overflow-hidden">
        {/* Top Header */}
        <header className="h-16 bg-zinc-900/50 backdrop-blur-md border-b border-zinc-800 flex items-center justify-between px-4 lg:px-8 z-10 shrink-0">
          <div className="flex items-center">
            <Button variant="ghost" size="icon" onClick={() => setIsSidebarOpen(!isSidebarOpen)} className="hidden md:flex text-zinc-400 hover:text-zinc-100">
              <Menu className="w-5 h-5" />
            </Button>
            {/* Mobile Title */}
            <div className="hidden md:flex relative max-w-md w-full">
              <Search className="absolute left-3 top-2.5 h-4 w-4 text-zinc-500" />
              <Input 
                placeholder="Search local..." 
                className="pl-9 bg-zinc-900 border-zinc-800 focus-visible:ring-zinc-600 h-8 w-full text-sm rounded-sm"
              />
            </div>
          </div>

          <div className="flex items-center space-x-4">
            <Popover>
              <PopoverTrigger
                render={
                  <Button variant="ghost" size="icon" className="relative text-zinc-400 hover:text-zinc-100 h-8 w-8">
                    <Bell className="w-4 h-4" />
                    <span className="absolute top-1.5 right-1.5 w-1.5 h-1.5 rounded-full bg-zinc-300" />
                  </Button>
                }
              />
              <PopoverContent align="end" className="w-80 bg-zinc-900 border-zinc-800 text-zinc-100 p-0">
                <div className="p-4 border-b border-zinc-800">
                  <h4 className="font-semibold text-sm">Notifications</h4>
                </div>
                <div className="p-4 text-sm text-zinc-400 text-center">
                  Syncing to Shore (1 event)
                </div>
              </PopoverContent>
            </Popover>

            <div className="w-8 h-8 rounded-full bg-gradient-to-tr from-blue-600 to-indigo-600 border border-zinc-700 shadow-inner" />
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
