'use client';

import { useEffect, useState } from 'react';
import { useTheme } from 'next-themes';
import { Sun, Moon, Monitor } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

const OPTIONS = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
] as const;

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  // Avoid rendering theme-dependent icon before hydration to prevent a mismatch.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const ActiveIcon = OPTIONS.find((o) => o.value === theme)?.icon ?? Monitor;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="ghost" size="icon" className="text-zinc-400 hover:text-zinc-100 h-8 w-8">
            {mounted ? <ActiveIcon className="w-4 h-4" /> : <Monitor className="w-4 h-4" />}
            <span className="sr-only">Toggle theme</span>
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="bg-slate-900 border-slate-800 text-slate-100">
        {OPTIONS.map((opt) => (
          <DropdownMenuItem
            key={opt.value}
            onClick={() => setTheme(opt.value)}
            className="focus:bg-slate-800 focus:text-slate-100 cursor-pointer gap-2"
          >
            <opt.icon className="w-4 h-4" />
            {opt.label}
            {theme === opt.value && <span className="ml-auto text-xs text-indigo-400">Active</span>}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
