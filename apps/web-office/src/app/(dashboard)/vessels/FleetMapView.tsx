'use client';

import { useMemo, useState } from 'react';
import { MapContainer, TileLayer, CircleMarker, Tooltip, Popup } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import { Card } from '@ovl/ui/components/card';
import { Input } from '@ovl/ui/components/input';
import { Button } from '@ovl/ui/components/button';
import { Search } from 'lucide-react';
import { trpc } from '@/lib/trpc';

// Ports ovl/web/office/src/screens/vessels/VesselMapView.tsx +
// ovl/office/httpapi/vesselpositions.go. The original anchors a detail
// card to each marker's live screen position with overlap-avoidance math
// against its own side panels — Leaflet's built-in Popup does the same
// job (click a marker, see its detail) without that bespoke geometry, so
// this port uses Popup instead. No heading/course-over-ground marker
// either: OVL has no course-over-ground field to point one, so a plain
// colored dot is all the backend data supports.
const STATUS_COLOR: Record<string, string> = {
  overdue: '#e53935',
  remarked: '#f0ad4e',
  ok: '#3fa34d',
};
const STATUS_LABEL: Record<string, string> = {
  overdue: 'Overdue',
  remarked: 'Remarked',
  ok: 'OK',
};
const STATUS_FILTERS = ['overdue', 'remarked', 'ok'] as const;

export function FleetMapView() {
  const { data: positions = [], isLoading } = trpc.vessels.positions.useQuery({});
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string | null>(null);

  const filtered = positions.filter(
    (p) =>
      (!statusFilter || p.status === statusFilter) &&
      (p.name.toLowerCase().includes(search.toLowerCase()) || p.imo.includes(search)),
  );

  const center = useMemo<[number, number]>(() => {
    if (positions.length === 0) return [20, 0];
    const avgLat = positions.reduce((s, p) => s + p.lat, 0) / positions.length;
    const avgLon = positions.reduce((s, p) => s + p.lon, 0) / positions.length;
    return [avgLat, avgLon];
  }, [positions]);

  return (
    <div className="relative flex-1 min-h-0 rounded-md overflow-hidden border border-border shadow-sm">
      <MapContainer center={center} zoom={positions.length > 0 ? 4 : 2} scrollWheelZoom className="h-full w-full">
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        {filtered.map((p) => (
          <CircleMarker
            key={p.id}
            center={[p.lat, p.lon]}
            radius={9}
            pathOptions={{ color: '#ffffff', weight: 2, fillColor: STATUS_COLOR[p.status], fillOpacity: 1 }}
          >
            <Tooltip direction="top" offset={[0, -8]}>
              {p.name}
            </Tooltip>
            <Popup>
              <div className="text-sm space-y-0.5">
                <div className="font-semibold">{p.name}</div>
                <div className="text-xs text-muted-foreground">IMO {p.imo}</div>
                <div className="text-xs">
                  {STATUS_LABEL[p.status]} · as of {new Date(p.asOf).toLocaleString()}
                </div>
              </div>
            </Popup>
          </CircleMarker>
        ))}
      </MapContainer>

      <Card className="absolute top-3 left-3 z-[1000] w-72 max-h-[calc(100%-24px)] flex flex-col bg-card border-border shadow-sm">
        <div className="p-3 space-y-2.5 shrink-0 border-b border-border">
          <div className="relative">
            <Search className="absolute left-2.5 top-2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              placeholder="Search vessel or IMO…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8 h-8 bg-card border-border text-sm"
            />
          </div>
          <div className="flex gap-1.5 flex-wrap">
            <Button
              size="xs"
              variant={statusFilter === null ? 'default' : 'outline'}
              onClick={() => setStatusFilter(null)}
            >
              All
            </Button>
            {STATUS_FILTERS.map((s) => (
              <Button
                key={s}
                size="xs"
                variant={statusFilter === s ? 'default' : 'outline'}
                onClick={() => setStatusFilter(s)}
              >
                <span
                  className="inline-block size-2 rounded-full mr-1"
                  style={{ backgroundColor: STATUS_COLOR[s] }}
                />
                {STATUS_LABEL[s]}
              </Button>
            ))}
          </div>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto p-1.5">
          {isLoading ? (
            <p className="text-xs text-muted-foreground text-center py-6">Loading…</p>
          ) : filtered.length > 0 ? (
            filtered.map((p) => (
              <div
                key={p.id}
                className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-muted transition-colors"
              >
                <span
                  className="inline-block size-2.5 rounded-full shrink-0"
                  style={{ backgroundColor: STATUS_COLOR[p.status] }}
                />
                <div className="min-w-0">
                  <div className="text-xs font-medium text-foreground truncate">{p.name}</div>
                  <div className="text-[0.65rem] text-muted-foreground">IMO {p.imo}</div>
                </div>
              </div>
            ))
          ) : (
            <p className="text-xs text-muted-foreground text-center py-6 px-3">
              No vessels have a plottable position yet — a vessel appears here once one of its Log
              Abstract reports carries a Position (Latitude/Longitude).
            </p>
          )}
        </div>
      </Card>
    </div>
  );
}
