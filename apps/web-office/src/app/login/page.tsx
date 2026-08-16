'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { signIn } from 'supertokens-auth-react/recipe/emailpassword';
import { Globe, Building2, KeyRound, ShieldCheck } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';

export default function OfficeLoginPage() {
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError('');
    
    try {
      const response = await signIn({
        formFields: [
          { id: "email", value: email },
          { id: "password", value: password }
        ]
      });
      
      if (response.status === "OK") {
        router.push('/');
      } else {
        setError("Invalid email or password");
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "An error occurred during login");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-zinc-950">
      <div className="w-full max-w-[400px] z-10 p-4">
        <Card className="bg-zinc-900 border-zinc-800 shadow-xl rounded-md">
          <CardHeader className="space-y-2 text-center pb-6 pt-8 border-b border-zinc-800/50">
            <div className="flex justify-center mb-4">
              <div className="p-2 bg-zinc-800/50 rounded-sm border border-zinc-700">
                <Globe className="w-6 h-6 text-zinc-300" />
              </div>
            </div>
            <div>
              <CardTitle className="text-xl font-medium tracking-tight text-zinc-100">
                OVL Command
              </CardTitle>
              <CardDescription className="text-zinc-400 mt-1 text-sm">
                Secure Office Authentication
              </CardDescription>
            </div>
          </CardHeader>
          <CardContent className="pt-6">
            <form onSubmit={handleLogin} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="email" className="text-zinc-300 text-xs uppercase tracking-wider font-medium">Corporate Email</Label>
                <div className="relative">
                  <Building2 className="absolute left-3 top-2.5 h-4 w-4 text-zinc-500" />
                  <Input 
                    id="email" 
                    type="email" 
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="admin@office.com" 
                    className="pl-9 bg-zinc-950/50 border-zinc-800 focus-visible:ring-zinc-600 text-zinc-100 rounded-sm h-9 text-sm"
                    required
                  />
                </div>
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label htmlFor="password" className="text-zinc-300 text-xs uppercase tracking-wider font-medium">Password</Label>
                </div>
                <div className="relative">
                  <KeyRound className="absolute left-3 top-2.5 h-4 w-4 text-zinc-500" />
                  <Input 
                    id="password" 
                    type="password" 
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••" 
                    className="pl-9 bg-zinc-950/50 border-zinc-800 focus-visible:ring-zinc-600 text-zinc-100 rounded-sm h-9 text-sm"
                    required
                  />
                </div>
              </div>
              {error && <div className="text-red-500 text-xs text-center">{error}</div>}
              <Button 
                type="submit" 
                className="w-full bg-zinc-100 hover:bg-white text-zinc-950 transition-all rounded-sm h-9 text-sm font-medium mt-4"
                disabled={isLoading}
              >
                {isLoading ? (
                  <ShieldCheck className="w-4 h-4 animate-spin" />
                ) : (
                  "Sign In"
                )}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
