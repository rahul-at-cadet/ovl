'use client';

import { ReactNode, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Globe, LayoutDashboard, Database, Ship, Users, Settings, Bell, Menu, LogOut, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';

interface AppShellProps {
  children: ReactNode;
}

export function AppShell({ children }: AppShellProps) {
  const pathname = usePathname();
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);

  const navItems = [
    { href: '/', label: 'Fleet Overview', icon: LayoutDashboard },
    { href: '/reports', label: 'Incoming Reports', icon: Database },
    { href: '/vessels', label: 'Vessel Management', icon: Ship },
    { href: '/users', label: 'Users & Roles', icon: Users },
    { href: '/settings', label: 'Global Settings', icon: Settings },
  ];

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex overflow-hidden">
      {/* Sidebar */}
      <aside
        className={`h-screen bg-slate-900 border-r border-slate-800 flex flex-col relative z-20 shrink-0 hidden md:flex transition-all duration-200 ${isSidebarOpen ? 'w-[260px]' : 'w-[70px]'}`}
      >
        <div className="h-14 flex items-center px-4 border-b border-zinc-800/50">
          <div className="p-1.5 bg-zinc-800 rounded-sm border border-zinc-700 mr-3 shrink-0">
            <Globe className="w-4 h-4 text-zinc-300" />
          </div>
          {isSidebarOpen && (
            <span className="font-medium text-sm tracking-tight whitespace-nowrap text-zinc-100">
              OVL Command
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

        <div className="p-4 border-t border-slate-800">
          <Link href="/login" className="flex items-center px-3 py-2.5 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800/50 transition-colors">
            <LogOut className="w-5 h-5 shrink-0" />
            {isSidebarOpen && <span className="ml-3 font-medium text-sm">Sign Out</span>}
          </Link>
        </div>
      </aside>

      {/* Main Content */}
      <div className="flex-1 flex flex-col h-screen overflow-hidden">
        {/* Top Header */}
        <header className="h-16 bg-slate-900/50 backdrop-blur-md border-b border-slate-800 flex items-center justify-between px-4 lg:px-8 z-10 shrink-0">
          <div className="flex items-center flex-1">
            <Button variant="ghost" size="icon" onClick={() => setIsSidebarOpen(!isSidebarOpen)} className="hidden md:flex text-slate-400 hover:text-slate-100 mr-4">
              <Menu className="w-5 h-5" />
            </Button>
            
            {/* Mobile Title */}
            <div className="md:hidden flex items-center mr-4">
               <Globe className="w-5 h-5 text-indigo-400 mr-2" />
               <span className="font-bold tracking-tight">OVL Command</span>
            </div>

            <div className="hidden md:flex relative max-w-md w-full">
              <Search className="absolute left-3 top-2.5 h-4 w-4 text-zinc-500" />
              <Input 
                placeholder="Search..." 
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
              <PopoverContent align="end" className="w-80 bg-slate-900 border-slate-800 text-slate-100 p-0">
                <div className="p-4 border-b border-slate-800 flex justify-between items-center">
                  <h4 className="font-semibold text-sm">Fleet Alerts</h4>
                  <span className="text-xs text-indigo-400 cursor-pointer hover:underline">Mark all read</span>
                </div>
                <div className="p-4 space-y-3">
                  <div className="flex gap-3 items-start">
                    <div className="w-2 h-2 rounded-full bg-indigo-500 mt-1.5" />
                    <div>
                      <p className="text-sm font-medium">New Bunker Report</p>
                      <p className="text-xs text-slate-400">Vessel &apos;Seawise Giant&apos; synced a new draft.</p>
                      <p className="text-xs text-slate-500 mt-1">2 mins ago</p>
                    </div>
                  </div>
                </div>
              </PopoverContent>
            </Popover>

            <Avatar className="h-8 w-8 border border-slate-700">
              <AvatarImage src="" />
              <AvatarFallback className="bg-indigo-600 text-white text-xs">AD</AvatarFallback>
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
