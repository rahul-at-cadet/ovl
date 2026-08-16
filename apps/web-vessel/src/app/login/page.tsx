'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Ship, User, KeyRound, ShieldCheck } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';

export default function LoginPage() {
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(false);

  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    // Simulate login delay
    setTimeout(() => {
      router.push('/');
    }, 1000);
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-zinc-950">
      <div className="w-full max-w-[400px] z-10 p-4">
        <Card className="bg-zinc-900 border-zinc-800 shadow-xl rounded-md">
          <CardHeader className="space-y-2 text-center pb-6 pt-8 border-b border-zinc-800/50">
            <div className="flex justify-center mb-4">
              <div className="p-2 bg-zinc-800/50 rounded-sm border border-zinc-700">
                <Ship className="w-6 h-6 text-zinc-300" />
              </div>
            </div>
            <div>
              <CardTitle className="text-xl font-medium tracking-tight text-zinc-100">
                Vessel Edge
              </CardTitle>
              <CardDescription className="text-zinc-400 mt-1 text-sm">
                Secure Terminal Authentication
              </CardDescription>
            </div>
          </CardHeader>
          <CardContent className="pt-6">
            <form onSubmit={handleLogin} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="id" className="text-zinc-300 text-xs uppercase tracking-wider font-medium">Crew ID</Label>
                <div className="relative">
                  <User className="absolute left-3 top-2.5 h-4 w-4 text-zinc-500" />
                  <Input 
                    id="id" 
                    placeholder="V-00192" 
                    className="pl-9 bg-zinc-950/50 border-zinc-800 focus-visible:ring-zinc-600 text-zinc-100 rounded-sm h-9 text-sm"
                    required
                  />
                </div>
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label htmlFor="password" className="text-zinc-300 text-xs uppercase tracking-wider font-medium">Passcode</Label>
                </div>
                <div className="relative">
                  <KeyRound className="absolute left-3 top-2.5 h-4 w-4 text-zinc-500" />
                  <Input 
                    id="password" 
                    type="password" 
                    placeholder="••••••••" 
                    className="pl-9 bg-zinc-950/50 border-zinc-800 focus-visible:ring-zinc-600 text-zinc-100 rounded-sm h-9 text-sm"
                    required
                  />
                </div>
              </div>
              <Button 
                type="submit" 
                className="w-full bg-zinc-100 hover:bg-white text-zinc-950 transition-all rounded-sm h-9 text-sm font-medium mt-4"
                disabled={isLoading}
              >
                {isLoading ? (
                  <ShieldCheck className="w-4 h-4 animate-spin" />
                ) : (
                  "Authenticate"
                )}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
