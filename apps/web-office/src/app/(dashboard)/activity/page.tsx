'use client';

import { useState } from 'react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@ovl/ui/components/card';
import { StatusBadge } from '@ovl/ui/components/status-badge';
import { Button } from '@ovl/ui/components/button';
import { ScrollText, ShieldAlert, Building2 } from 'lucide-react';
import { trpc } from '@/lib/trpc';

/**
 * The audit log, for whoever is allowed to read one.
 *
 * A platform super admin sees every tenant's events; a tenant's own admin sees
 * only their own. That split is enforced server-side in audit.router.ts — the
 * tenant filter for a tenant admin is imposed from their session, not taken
 * from anything this page sends. What is decided here is only which controls
 * to offer, so the screen never presents a filter that would be ignored.
 */

/** Retention class → the colour vocabulary StatusBadge already speaks. */
const CLASS_ROLE = {
  auth: 'info',
  admin: 'warn',
  impersonation: 'attention',
} as const;

const CLASS_LABEL = {
  auth: 'Authentication',
  admin: 'Administration',
  impersonation: 'Impersonation',
} as const;

const FILTERS = ['All', 'Authentication', 'Administration', 'Impersonation'] as const;
type Filter = (typeof FILTERS)[number];

const FILTER_CLASS: Record<Filter, 'auth' | 'admin' | 'impersonation' | undefined> = {
  All: undefined,
  Authentication: 'auth',
  Administration: 'admin',
  Impersonation: 'impersonation',
};

/** `impersonation.mode_changed` → `Mode changed`. */
function eventLabel(event: string): string {
  const name = event.includes('.') ? event.slice(event.indexOf('.') + 1) : event;
  const words = name.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The event-specific fields, as a short readable line rather than raw JSON. */
function detailLine(detail: Record<string, unknown>): string {
  return Object.entries(detail)
    .filter(([key]) => key !== 'userId')
    .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : String(value)}`)
    .join(' · ');
}

export default function ActivityPage() {
  const [filter, setFilter] = useState<Filter>('All');

  const { data: capabilities, isLoading: loadingCapabilities } =
    trpc.audit.capabilities.useQuery();

  const canRead = capabilities?.canRead && capabilities.available;

  const { data: events = [], isLoading } = trpc.audit.list.useQuery(
    { eventClass: FILTER_CLASS[filter], limit: 200 },
    { enabled: Boolean(canRead) },
  );

  if (loadingCapabilities) {
    return <div className="text-sm text-muted-foreground">Loading activity log...</div>;
  }

  // Not an error page: an ordinary user reaching this URL has done nothing
  // wrong, and the nav does not offer them the link in the first place.
  if (!canRead) {
    return (
      <Card className="bg-card border-border rounded-md">
        <CardContent className="py-10 flex flex-col items-center text-center gap-3">
          <ShieldAlert className="w-6 h-6 text-muted-foreground" />
          <div>
            <p className="text-sm font-medium text-foreground">
              {capabilities?.available
                ? 'The activity log is for administrators.'
                : 'The activity log is not enabled on this deployment.'}
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              {capabilities?.available
                ? 'Ask an administrator of your organisation if you need to see it.'
                : 'It needs MULTI_TENANCY_ENABLED and the platform schema.'}
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 min-w-0">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Activity Log</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {capabilities?.canReadAllTenants
              ? 'Sign-ins, administrative changes, and every platform visit into a tenant.'
              : "Sign-ins and administrative changes in your organisation, including any platform operator's visit."}
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5 min-w-0">
          {FILTERS.map((f) => (
            <Button
              key={f}
              variant={filter === f ? 'secondary' : 'ghost'}
              size="sm"
              onClick={() => setFilter(f)}
            >
              {f}
            </Button>
          ))}
        </div>
      </div>

      <Card className="bg-card border-border rounded-md">
        <CardHeader className="pb-3">
          <CardTitle className="text-base font-semibold text-foreground">Recent activity</CardTitle>
          <CardDescription className="text-xs text-muted-foreground">
            Newest first. Entries cannot be edited or removed — authentication is kept for 12
            months, administrative changes for 24, and platform visits for 36.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left text-muted-foreground">
              <thead className="text-xs text-muted-foreground uppercase tracking-wider bg-card border-b border-border">
                <tr>
                  <th scope="col" className="px-4 py-2 font-semibold">When</th>
                  <th scope="col" className="px-4 py-2 font-semibold">Event</th>
                  <th scope="col" className="px-4 py-2 font-semibold">Actor</th>
                  {capabilities?.canReadAllTenants && (
                    <th scope="col" className="hidden lg:table-cell px-4 py-2 font-semibold">
                      Tenant
                    </th>
                  )}
                  <th scope="col" className="hidden md:table-cell px-4 py-2 font-semibold">
                    Subject
                  </th>
                  <th scope="col" className="hidden xl:table-cell px-4 py-2 font-semibold">
                    Details
                  </th>
                </tr>
              </thead>
              <tbody>
                {isLoading ? (
                  <tr>
                    <td colSpan={6} className="px-6 py-12 text-center text-muted-foreground">
                      Loading activity...
                    </td>
                  </tr>
                ) : events.length > 0 ? (
                  events.map((e) => (
                    <tr key={e.id} className="border-b border-border last:border-0 hover:bg-muted/50">
                      <td className="px-4 py-3 whitespace-nowrap text-xs">
                        {new Date(e.at).toLocaleString()}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="text-sm text-foreground whitespace-nowrap">
                            {eventLabel(e.event)}
                          </span>
                          {e.outcome === 'failure' && (
                            <StatusBadge role="critical" label="Failed" size="sm" />
                          )}
                          <StatusBadge
                            role={CLASS_ROLE[e.eventClass]}
                            label={CLASS_LABEL[e.eventClass]}
                            size="sm"
                            showIcon={false}
                          />
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="min-w-0">
                          <p className="text-sm text-foreground truncate">
                            {e.actorEmail ?? e.actorUserId ?? 'Unknown'}
                          </p>
                          {e.ip && <p className="text-xs text-muted-foreground truncate">{e.ip}</p>}
                        </div>
                      </td>
                      {capabilities?.canReadAllTenants && (
                        <td className="hidden lg:table-cell px-4 py-3">
                          {e.tenantName ? (
                            <div className="flex items-center gap-1.5 min-w-0">
                              <Building2 className="w-3.5 h-3.5 shrink-0" />
                              <span className="text-xs truncate">{e.tenantName}</span>
                            </div>
                          ) : (
                            <span className="text-xs">Platform</span>
                          )}
                        </td>
                      )}
                      <td className="hidden md:table-cell px-4 py-3 text-xs truncate max-w-[16rem]">
                        {e.subject ?? '—'}
                      </td>
                      <td className="hidden xl:table-cell px-4 py-3 text-xs truncate max-w-[20rem]">
                        {detailLine(e.detail) || '—'}
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={6} className="px-6 py-12 text-center">
                      <ScrollText className="w-6 h-6 mx-auto mb-2 text-muted-foreground" />
                      <p className="text-sm text-muted-foreground">
                        Nothing recorded{filter === 'All' ? ' yet' : ` under ${filter}`}.
                      </p>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
