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
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError('');
    
    try {
      const res = await fetch('http://localhost:3003/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ username, password })
      });
      
      if (!res.ok) {
        throw new Error('Invalid credentials');
      }
      
      const data = await res.json();
      
      if (data.mustChangePassword) {
        router.push('/account/force-password-change');
      } else {
        // Full page reload or router.push
        window.location.href = '/';
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="w-full max-w-[400px] z-10 p-4">
        <Card className="bg-card border-border shadow-xl rounded-md">
          <CardHeader className="space-y-2 text-center pb-6 pt-8 border-b border-border/50">
            <div className="flex justify-center mb-4">
              <div className="p-2 bg-muted/50 rounded-sm border border-border">
                <Ship className="w-6 h-6 text-foreground" />
              </div>
            </div>
            <div>
              <CardTitle className="text-xl font-medium tracking-tight text-foreground">
                Vessel Edge
              </CardTitle>
              <CardDescription className="text-muted-foreground mt-1 text-sm">
                Secure Terminal Authentication
              </CardDescription>
            </div>
          </CardHeader>
          <CardContent className="pt-6">
            <form onSubmit={handleLogin} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="id" className="text-foreground text-xs uppercase tracking-wider font-medium">Crew ID</Label>
                <div className="relative">
                  <User className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                  <Input 
                    id="id" 
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder="e.g. master" 
                    className="pl-9 bg-background/50 border-border focus-visible:ring-ring text-foreground rounded-sm h-9 text-sm"
                    required
                  />
                </div>
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label htmlFor="password" className="text-foreground text-xs uppercase tracking-wider font-medium">Passcode</Label>
                </div>
                <div className="relative">
                  <KeyRound className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                  <Input 
                    id="password" 
                    type="password" 
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••" 
                    className="pl-9 bg-background/50 border-border focus-visible:ring-ring text-foreground rounded-sm h-9 text-sm"
                    required
                  />
                </div>
              </div>
              {error && (
                <div className="text-red-400 text-xs font-medium bg-red-400/10 p-2 rounded-sm border border-red-400/20">
                  {error}
                </div>
              )}
              <Button 
                type="submit" 
                className="w-full bg-primary hover:bg-white text-primary-foreground transition-all rounded-sm h-9 text-sm font-medium mt-4"
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
