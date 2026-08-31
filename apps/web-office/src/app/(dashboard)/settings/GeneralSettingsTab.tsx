'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from '@ovl/ui/components/card';
import { Button } from '@ovl/ui/components/button';
import { Input } from '@ovl/ui/components/input';
import { Label } from '@ovl/ui/components/label';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@ovl/ui/components/select';
import { Loader2, Upload, Trash2, CheckCircle2 } from 'lucide-react';
import { trpc } from '@/lib/trpc';

/**
 * What the server will accept, checked here too so the person finds out while
 * they are still looking at the file picker rather than after a round trip.
 * The server is the authority — see TenantSettingsService.
 */
const ACCEPTED_LOGO_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const MAX_LOGO_BYTES = 96 * 1024;

/**
 * Organisation identity: company name, logo and default timezone.
 *
 * All three were previously hardcoded `defaultValue` inputs with a Save button
 * that had no handler, so nothing a person typed here was ever kept — the
 * reported "unable to change and save company name". They are now the tenant's
 * real settings, read and written through `tenants.settings`.
 *
 * Company Name is the tenant's own name, the one given when the tenant was
 * provisioned, and it is what the shell shows on every screen — so renaming
 * here renames the workspace everywhere.
 */
export function GeneralSettingsTab() {
  const utils = trpc.useUtils();
  const { data: settings, isLoading } = trpc.tenants.settings.useQuery();

  const [name, setName] = useState('');
  const [timezone, setTimezone] = useState('UTC');
  const [logo, setLogo] = useState<string | null>(null);
  const [logoError, setLogoError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  // Seed the form once the real values arrive. Keyed on the server values so a
  // save that changes them re-syncs, without stamping over typing in between.
  useEffect(() => {
    if (!settings) return;
    setName(settings.name);
    setTimezone(settings.defaultTimezone);
    setLogo(settings.logoDataUrl);
  }, [settings]);

  const saveMutation = trpc.tenants.updateSettings.useMutation({
    meta: { errorTitle: "Couldn't save settings" },
    onSuccess: async () => {
      // The shell reads the name and logo from tenants.capabilities, so that
      // query has to be refreshed too or the sidebar keeps the old branding
      // until the next full page load.
      await Promise.all([
        utils.tenants.settings.invalidate(),
        utils.tenants.capabilities.invalidate(),
      ]);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    },
  });

  const zones = useTimezoneOptions();

  const dirty =
    !!settings &&
    (name !== settings.name ||
      timezone !== settings.defaultTimezone ||
      logo !== settings.logoDataUrl);

  function handleLogoPicked(file: File) {
    setLogoError(null);
    if (!ACCEPTED_LOGO_TYPES.includes(file.type)) {
      setLogoError('Use a PNG, JPEG, WebP or GIF.');
      return;
    }
    if (file.size > MAX_LOGO_BYTES) {
      setLogoError(`That file is ${Math.round(file.size / 1024)}KB. Keep it under ${MAX_LOGO_BYTES / 1024}KB.`);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setLogo(typeof reader.result === 'string' ? reader.result : null);
    reader.onerror = () => setLogoError('Could not read that file.');
    reader.readAsDataURL(file);
  }

  return (
    <Card className="bg-card border-border shadow-sm overflow-hidden rounded-md">
      <CardHeader className="border-b border-border pb-4 bg-card">
        <CardTitle className="text-sm font-semibold tracking-tight text-foreground">
          Organization Identity
        </CardTitle>
        <CardDescription className="text-xs text-muted-foreground">
          Your company name, logo and default timezone. The name and logo appear across the app.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-6 pt-6">
        <div className="space-y-2 max-w-md">
          <Label htmlFor="company-name" className="text-xs font-semibold text-foreground uppercase tracking-wider">
            Company Name
          </Label>
          <Input
            id="company-name"
            value={name}
            disabled={isLoading}
            onChange={(e) => setName(e.target.value)}
            placeholder={isLoading ? 'Loading…' : 'e.g. Northstar Shipping'}
            className="bg-card border-border text-foreground text-sm h-10"
          />
        </div>

        <div className="space-y-2 max-w-md">
          <Label className="text-xs font-semibold text-foreground uppercase tracking-wider">
            Company Logo
          </Label>
          <div className="flex items-center gap-4">
            <div className="h-14 w-28 shrink-0 rounded-md border border-border bg-background flex items-center justify-center overflow-hidden">
              {logo ? (
                <img src={logo} alt="Company logo" className="max-h-12 max-w-24 object-contain" />
              ) : (
                <span className="text-[10px] text-muted-foreground">No logo</span>
              )}
            </div>
            <div className="flex flex-col gap-2 min-w-0">
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => fileInput.current?.click()}
                >
                  <Upload className="w-3.5 h-3.5" />
                  {logo ? 'Replace' : 'Upload'}
                </Button>
                {logo && (
                  <Button type="button" variant="outline" size="sm" onClick={() => setLogo(null)}>
                    <Trash2 className="w-3.5 h-3.5" />
                    Remove
                  </Button>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                PNG, JPEG, WebP or GIF, under {MAX_LOGO_BYTES / 1024}KB. A wide logo works best.
              </p>
              {logoError && <p className="text-xs text-status-critical">{logoError}</p>}
            </div>
          </div>
          <input
            ref={fileInput}
            type="file"
            accept={ACCEPTED_LOGO_TYPES.join(',')}
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleLogoPicked(file);
              // Cleared so picking the same file twice still fires a change.
              e.target.value = '';
            }}
          />
        </div>

        <div className="space-y-2 max-w-md">
          <Label className="text-xs font-semibold text-foreground uppercase tracking-wider">
            Default Timezone
          </Label>
          <Select value={timezone} onValueChange={(v: unknown) => v && setTimezone(String(v))}>
            <SelectTrigger className="bg-card border-border text-foreground h-10" disabled={isLoading}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="max-h-80">
              {zones.map((group) => (
                <SelectGroup key={group.region}>
                  <SelectLabel>{group.region}</SelectLabel>
                  {group.zones.map((z) => (
                    <SelectItem key={z.id} value={z.id}>
                      {z.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            Used when a date is shown without a zone of its own.
          </p>
        </div>
      </CardContent>

      <CardFooter className="bg-card border-t border-border p-4 flex justify-end items-center gap-3">
        {saved && !dirty && (
          <span className="text-xs text-status-ok flex items-center gap-1.5">
            <CheckCircle2 className="w-3.5 h-3.5" />
            Saved
          </span>
        )}
        <Button
          disabled={!dirty || saveMutation.isPending || isLoading}
          onClick={() =>
            saveMutation.mutate({
              name,
              defaultTimezone: timezone,
              logoDataUrl: logo,
            })
          }
          className="bg-primary hover:bg-primary/90 text-primary-foreground rounded-md h-9 text-sm font-semibold shadow-sm transition-all"
        >
          {saveMutation.isPending && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
          {saveMutation.isPending ? 'Saving…' : 'Save Changes'}
        </Button>
      </CardFooter>
    </Card>
  );
}

interface ZoneGroup {
  region: string;
  zones: Array<{ id: string; label: string }>;
}

/**
 * Every IANA zone this browser knows, grouped by region and labelled with its
 * current UTC offset.
 *
 * Asked of `Intl` rather than kept as a list in the repo, because the zone
 * database changes — zones are added, renamed and retired — and a hardcoded
 * copy starts lying the moment the runtime updates underneath it. The server
 * validates the same way.
 *
 * Computed once: formatting 400-odd zones is not free, and none of it changes
 * while the page is open.
 */
function useTimezoneOptions(): ZoneGroup[] {
  return useMemo(() => {
    const supported = (
      Intl as unknown as { supportedValuesOf?: (k: string) => string[] }
    ).supportedValuesOf;

    // Older engines have no supportedValuesOf. UTC alone is a poor list, but a
    // dropdown with one correct entry beats a crash.
    const ids: string[] = supported ? supported('timeZone') : ['UTC'];
    if (!ids.includes('UTC')) ids.unshift('UTC');

    const groups = new Map<string, Array<{ id: string; label: string }>>();
    for (const id of ids) {
      const region = id.includes('/') ? id.slice(0, id.indexOf('/')) : 'UTC';
      const city = id.includes('/') ? id.slice(id.indexOf('/') + 1).replace(/_/g, ' ') : id;
      const label = `${city} (${offsetLabel(id)})`;
      const list = groups.get(region) ?? [];
      list.push({ id, label });
      groups.set(region, list);
    }

    return [...groups.entries()]
      .map(([region, zones]) => ({
        region,
        zones: zones.sort((a, b) => a.label.localeCompare(b.label)),
      }))
      // UTC first — it is the sensible default and the one people look for.
      .sort((a, b) => (a.region === 'UTC' ? -1 : b.region === 'UTC' ? 1 : a.region.localeCompare(b.region)));
  }, []);
}

/** "UTC+02:00" for a zone, as of now. */
function offsetLabel(timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      timeZoneName: 'longOffset',
    }).formatToParts(new Date());
    return parts.find((p) => p.type === 'timeZoneName')?.value ?? 'UTC';
  } catch {
    return 'UTC';
  }
}
