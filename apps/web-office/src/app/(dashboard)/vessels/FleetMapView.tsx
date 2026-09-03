'use client';

import Link from 'next/link';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MapContainer, TileLayer, Marker, Tooltip, Popup, useMap } from 'react-leaflet';
import { divIcon, type Map as LeafletMap } from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Input } from '@ovl/ui/components/input';
import { Button } from '@ovl/ui/components/button';
import { Search, Crosshair, ChevronLeft, ChevronRight, X } from 'lucide-react';
import { trpc } from '@/lib/trpc';

// Ports ovl/web/office/src/screens/vessels/VesselMapView.tsx +
// ovl/office/httpapi/vesselpositions.go. The original anchors a detail
// card to each marker's live screen position with overlap-avoidance math
// against its own side panels — Leaflet's built-in Popup does the same
// job (click a marker, see its detail) without that bespoke geometry, so
// this port uses Popup instead. No heading/course-over-ground marker
// either: OVL has no course-over-ground field to point one, so a plain
// colored dot is all the backend data supports.
// Theme tokens, not raw hex. globals.css defines a five-role semantic
// status scale precisely so nothing hardcodes a colour that can't follow
// the theme — the previous #e53935/#f0ad4e/#3fa34d were tuned for a
// light basemap and stayed put in dark mode, which is why the markers
// and legend read as belonging to a different product. Mapping the
// map's three states onto that scale keeps them in step with every
// other status indicator in the app.
const STATUS_COLOR: Record<string, string> = {
  overdue: 'var(--status-critical)',
  remarked: 'var(--status-attention)',
  ok: 'var(--status-ok)',
};
const STATUS_LABEL: Record<string, string> = {
  overdue: 'Overdue',
  remarked: 'Remarked',
  ok: 'OK',
};
const STATUS_FILTERS = ['overdue', 'remarked', 'ok'] as const;

/**
 * Marker diameter as a function of zoom, in px.
 *
 * This replaced a manual S/M/L control. That control was the wrong
 * answer twice over: sizing markers by hand isn't a pattern operators
 * recognise (nothing in the map's own language says what "S/M/L" sizes),
 * and changing it rebuilt every marker's icon, which made Leaflet
 * re-add the markers and re-anchor any open popup — the map visibly
 * jumped to a different point.
 *
 * Density is really a zoom problem: zoomed out, a fleet in one sea area
 * collides into a blob and wants small dots; zoomed in, there's room for
 * a larger, easier target. Deriving size from zoom handles that with no
 * control to explain and nothing for the operator to get wrong.
 *
 * Clustering — the other standard answer to density — is deliberately
 * not used: for live position tracking, collapsing vessels into a count
 * hides the individual positions that are the entire point of the view.
 */
function dotDiameterForZoom(zoom: number): number {
  if (zoom <= 2) return 9;
  if (zoom <= 4) return 12;
  if (zoom <= 6) return 15;
  if (zoom <= 9) return 18;
  return 22;
}

// Popup and tooltip chrome is themed in globals.css, not here — see the
// "Fleet map (Leaflet) theming" block there for why utilities can't do
// it (Tailwind v4 layers lose to leaflet.css's unlayered rules).

type Position = {
  id: string;
  name: string;
  imo: string;
  groups: string[];
  lat: number;
  lon: number;
  status: string;
  asOf: string;
};

/**
 * Position age, worth surfacing because the map plots the last report
 * that *carried* a position rather than the last report outright — a
 * marker can legitimately be days old, and "where it was" reads very
 * differently from "where it is".
 */
function relativeAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return 'just now';
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? 'yesterday' : `${days}d ago`;
}

/** Decimal degrees back to the DDM form officers actually read. */
function formatCoord(value: number, positive: string, negative: string): string {
  const hemi = value >= 0 ? positive : negative;
  const abs = Math.abs(value);
  const deg = Math.floor(abs);
  const min = (abs - deg) * 60;
  return `${deg}° ${min.toFixed(1)}′ ${hemi}`;
}

/**
 * Imperatively drives the map from selection/list state. Leaflet owns
 * its own view, so panning has to go through the instance rather than
 * through props — this component exists only to bridge the two.
 */
function MapController({
  selected,
  onMapReady,
}: {
  selected: Position | null;
  onMapReady: (map: LeafletMap) => void;
}) {
  const map = useMap();

  useEffect(() => {
    onMapReady(map);
  }, [map, onMapReady]);

  // Marker size is published as a CSS variable on the map container and
  // read by every marker, rather than baked into each divIcon's HTML.
  // That distinction is the whole fix for the "map jumps when the size
  // changes" bug: writing a variable restyles the existing markers in
  // place, whereas rebuilding the icons made Leaflet remove and re-add
  // every marker, which re-anchored the open popup and let its autoPan
  // drag the viewport somewhere else.
  useEffect(() => {
    const apply = () => {
      map.getContainer().style.setProperty('--dot', `${dotDiameterForZoom(map.getZoom())}px`);
    };
    apply();
    map.on('zoomend', apply);
    return () => {
      map.off('zoomend', apply);
    };
  }, [map]);

  useEffect(() => {
    if (!selected) return;
    map.flyTo([selected.lat, selected.lon], Math.max(map.getZoom(), 6), { duration: 0.6 });
  }, [selected, map]);

  return null;
}

/**
 * Tracks the app's own light/dark state so the basemap can follow it.
 * The theme is expressed as a `dark` class on <html> and can be toggled
 * at runtime from the header, so this observes the attribute rather than
 * reading it once at mount.
 */
function useIsDarkTheme(): boolean {
  const [isDark, setIsDark] = useState(false);

  useEffect(() => {
    const el = document.documentElement;
    const read = () => setIsDark(el.classList.contains('dark'));
    read();
    const observer = new MutationObserver(read);
    observer.observe(el, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  return isDark;
}

export function FleetMapView() {
  const { data: positions = [], isLoading } = trpc.vessels.positions.useQuery({});
  const isDark = useIsDarkTheme();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(true);
  const mapRef = useRef<LeafletMap | null>(null);


  const handleMapReady = useCallback((map: LeafletMap) => {
    mapRef.current = map;
  }, []);

  const filtered = useMemo(
    () =>
      (positions as Position[]).filter(
        (p) =>
          (!statusFilter || p.status === statusFilter) &&
          (p.name.toLowerCase().includes(search.toLowerCase()) || p.imo.includes(search)),
      ),
    [positions, statusFilter, search],
  );

  // Counts come from the unfiltered set so the filter chips always show
  // how much each one would surface, not how much survived the current
  // filter (which would read 0 for every chip you aren't on).
  const counts = useMemo(() => {
    const c: Record<string, number> = { overdue: 0, remarked: 0, ok: 0 };
    for (const p of positions as Position[]) if (p.status in c) c[p.status]++;
    return c;
  }, [positions]);

  const selected = useMemo(
    () => filtered.find((p) => p.id === selectedId) ?? null,
    [filtered, selectedId],
  );

  const center = useMemo<[number, number]>(() => {
    if (positions.length === 0) return [20, 0];
    const avgLat = (positions as Position[]).reduce((s, p) => s + p.lat, 0) / positions.length;
    const avgLon = (positions as Position[]).reduce((s, p) => s + p.lon, 0) / positions.length;
    return [avgLat, avgLon];
  }, [positions]);

  /** Frame every currently-filtered vessel, the map's one "get me un-lost" control. */
  const fitAll = useCallback(() => {
    const map = mapRef.current;
    if (!map || filtered.length === 0) return;
    // Drop the selection first: an open popup auto-pans to stay in view,
    // which drags the map straight back to that one marker and undoes
    // the fit. "Show me everything" and "focus this one" are opposites.
    setSelectedId(null);
    map.closePopup();
    if (filtered.length === 1) {
      map.flyTo([filtered[0].lat, filtered[0].lon], 6, { duration: 0.6 });
      return;
    }
    const lats = filtered.map((p) => p.lat);
    const lons = filtered.map((p) => p.lon);
    map.flyToBounds(
      [
        [Math.min(...lats), Math.min(...lons)],
        [Math.max(...lats), Math.max(...lons)],
      ],
      { padding: [60, 60], duration: 0.6 },
    );
  }, [filtered]);

  return (
    /* `isolate` is load-bearing, not decoration. Leaflet stacks its own
       panes up to z-index 700 and its controls at 1000, and this wrapper
       was `relative` with no z-index — so it created no stacking context
       and all of that competed directly with the rest of the app. A modal
       dialog sits at z-50, which meant the map painted straight over it:
       clicking Provision Node in map view opened a dialog nobody could
       see. Isolating the map keeps its internal layering intact while
       containing it, so anything portalled to the body wins as it should. */
    <div className="relative isolate flex-1 min-h-0 rounded-lg overflow-hidden border border-border shadow-sm">
      <MapContainer
        center={center}
        zoom={positions.length > 0 ? 4 : 2}
        scrollWheelZoom
        zoomControl={false}
        className="h-full w-full"
      >
        {/* Plain OSM tiles. A dark basemap is achieved by filtering these
            in CSS (see "Fleet map dark basemap" in globals.css) rather
            than by switching provider: CARTO's dark_all/light_all now
            watermark every tile with "API KEY REQUIRED", and the other
            hosted dark styles either need a key too or carry
            non-commercial terms. Filtering the tiles we already have the
            right to use keeps the map keyless and adds no new
            third-party dependency or attribution obligation. */}
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          maxZoom={19}
        />
        <MapController selected={selected} onMapReady={handleMapReady} />
        {filtered.map((p) => {
          const isSelected = p.id === selectedId;
          return (
            <Marker
              key={p.id}
              position={[p.lat, p.lon]}
              // An HTML divIcon rather than an SVG CircleMarker: the
              // marker's look (elevation shadows, the selected ring, the
              // overdue pulse, hover growth) is all CSS that an SVG
              // circle can't express — see the "Fleet map markers" block
              // in globals.css. Only the per-marker values travel here.
              icon={divIcon({
                className: 'ovl-marker-wrap',
                iconSize: [0, 0],
                iconAnchor: [0, 0],
                html:
                  `<div class="ovl-marker${isSelected ? ' ovl-marker--selected' : ''}` +
                  `${p.status === 'overdue' ? ' ovl-marker--overdue' : ''}" ` +
                  `style="--dot-color:${STATUS_COLOR[p.status]}">` +
                  `<span class="ovl-marker__dot"></span></div>`,
              })}
              eventHandlers={{ click: () => setSelectedId(p.id) }}
            >
              <Tooltip direction="top" offset={[0, -10]}>
                {p.name}
              </Tooltip>
              <Popup autoPanPadding={[24, 24]}>
                {/* Three bands — identity, state, provenance — separated
                    by real dividers, so the popup reads as a small card
                    with a hierarchy rather than one undifferentiated
                    stack of lines. */}
                <div className="w-[15rem] overflow-hidden">
                  <div className="flex items-start gap-2 px-3 pb-2.5 pt-3">
                    <span
                      className="mt-1 inline-block size-2.5 shrink-0 rounded-full ring-2 ring-card"
                      style={{ backgroundColor: STATUS_COLOR[p.status] }}
                    />
                    <span className="min-w-0 flex-1 pr-4">
                      <span className="block truncate text-sm font-semibold leading-tight text-foreground">
                        {p.name}
                      </span>
                      <span className="block text-xs tabular-nums text-muted-foreground">IMO {p.imo}</span>
                    </span>
                  </div>

                  <div className="border-t border-border px-3 py-2">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-xs font-medium text-foreground">{STATUS_LABEL[p.status]}</span>
                      <span className="text-xs text-muted-foreground">{relativeAge(p.asOf)}</span>
                    </div>
                    <div className="mt-1 font-mono text-xs tabular-nums text-muted-foreground">
                      {formatCoord(p.lat, 'N', 'S')}
                      <span className="px-1 opacity-50">/</span>
                      {formatCoord(p.lon, 'E', 'W')}
                    </div>
                  </div>

                  {p.groups.length > 0 ? (
                    <div className="flex flex-wrap gap-1 border-t border-border px-3 py-2">
                      {p.groups.map((g) => (
                        <span
                          key={g}
                          className="rounded border border-border bg-muted px-1.5 py-0.5 text-[0.65rem] font-medium text-muted-foreground"
                        >
                          {g}
                        </span>
                      ))}
                    </div>
                  ) : null}

                  <div className="border-t border-border px-3 py-1.5 text-[0.65rem] text-muted-foreground">
                    As of {new Date(p.asOf).toLocaleString()}
                  </div>

                  {/* The way into the detail screen from map view. The
                      side-panel rows deliberately focus the marker rather
                      than navigating — that is what a map list is for —
                      which left the map with no drill-in at all. */}
                  <Link
                    href={`/vessels/${p.id}`}
                    className="flex items-center justify-between gap-2 border-t border-border px-3 py-2 text-xs font-medium text-primary transition-colors hover:bg-muted"
                  >
                    Open vessel
                    <ChevronRight className="size-3.5" />
                  </Link>
                </div>
              </Popup>
            </Marker>
          );
        })}
      </MapContainer>

      {/* Collapsed handle — the map is the point, so the panel can get out of the way. */}
      {!panelOpen ? (
        <button
          type="button"
          onClick={() => setPanelOpen(true)}
          className="absolute top-3 left-3 z-[1000] flex items-center gap-1.5 rounded-lg border border-border bg-card/95 px-3 py-2 text-xs font-medium text-foreground shadow-lg backdrop-blur-sm transition-colors hover:bg-muted"
        >
          <Search className="size-3.5" />
          {filtered.length} vessel{filtered.length === 1 ? '' : 's'}
        </button>
      ) : (
        <div className="absolute top-3 left-3 z-[1000] flex w-[17rem] max-h-[calc(100%-1.5rem)] flex-col overflow-hidden rounded-lg border border-border bg-card/95 shadow-lg ring-1 ring-black/5 backdrop-blur-sm">
          <div className="shrink-0 space-y-2.5 border-b border-border p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Fleet Positions
              </span>
              <button
                type="button"
                onClick={() => setPanelOpen(false)}
                aria-label="Collapse panel"
                className="-mr-1 rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <ChevronLeft className="size-3.5" />
              </button>
            </div>

            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-2 size-3.5 text-muted-foreground" />
              <Input
                placeholder="Search vessel or IMO…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="h-8 border-border bg-background pl-8 pr-7 text-sm"
              />
              {search ? (
                <button
                  type="button"
                  onClick={() => setSearch('')}
                  aria-label="Clear search"
                  className="absolute right-1.5 top-1.5 rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  <X className="size-3" />
                </button>
              ) : null}
            </div>

            {/* A fixed 2×2 grid rather than a wrapping flex row: four
                equal cells line up on both axes, so the chips read as one
                control instead of four differently-sized pills breaking
                across rows at whatever width the panel happens to be.
                Label left, count right in every cell, so the numbers form
                their own column. */}
            <div className="grid grid-cols-2 gap-1.5">
              {([{ key: null, label: 'All', color: null, count: positions.length }] as const)
                .concat(
                  STATUS_FILTERS.map((s) => ({
                    key: s,
                    label: STATUS_LABEL[s],
                    color: STATUS_COLOR[s],
                    count: counts[s],
                  })) as never,
                )
                .map((f) => {
                  const active = statusFilter === f.key;
                  const empty = f.key !== null && f.count === 0;
                  return (
                    <button
                      key={f.label}
                      type="button"
                      // Filtering to a status with nothing in it just
                      // empties the map with no way to tell why.
                      disabled={empty}
                      aria-pressed={active}
                      onClick={() => setStatusFilter(active && f.key !== null ? null : f.key)}
                      className={`flex h-7 items-center gap-1.5 rounded-md border px-2 text-xs font-medium transition-colors disabled:pointer-events-none disabled:opacity-40 ${
                        active
                          ? 'border-primary bg-primary text-primary-foreground'
                          : 'border-border bg-background text-foreground hover:bg-muted'
                      }`}
                    >
                      {f.color ? (
                        <span
                          className="inline-block size-2 shrink-0 rounded-full"
                          style={{ backgroundColor: f.color }}
                        />
                      ) : null}
                      <span className="flex-1 text-left">{f.label}</span>
                      <span className={`tabular-nums ${active ? 'opacity-80' : 'text-muted-foreground'}`}>
                        {f.count}
                      </span>
                    </button>
                  );
                })}
            </div>
          </div>

          {/* The scroll container is masked at both ends, so a list that
              continues past the fold fades out instead of being sliced
              mid-row against the header — a hard clip reads as a layout
              bug rather than as "there is more below". */}
          <div
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1.5"
            style={{
              maskImage:
                'linear-gradient(to bottom, transparent 0, #000 0.6rem, #000 calc(100% - 0.6rem), transparent 100%)',
              WebkitMaskImage:
                'linear-gradient(to bottom, transparent 0, #000 0.6rem, #000 calc(100% - 0.6rem), transparent 100%)',
            }}
          >
            {isLoading ? (
              <p className="py-6 text-center text-xs text-muted-foreground">Loading…</p>
            ) : filtered.length > 0 ? (
              filtered.map((p) => {
                const isSelected = p.id === selectedId;
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => setSelectedId(p.id)}
                    aria-current={isSelected}
                    className={`flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left transition-colors ${
                      isSelected ? 'bg-primary/10 ring-1 ring-primary/30' : 'hover:bg-muted'
                    }`}
                  >
                    <span
                      className="inline-block size-2 shrink-0 rounded-full ring-2 ring-card"
                      style={{ backgroundColor: STATUS_COLOR[p.status] }}
                    />
                    <span className="min-w-0 flex-1 leading-tight">
                      <span className="block truncate text-xs font-medium text-foreground">{p.name}</span>
                      <span className="mt-0.5 block truncate text-[0.65rem] tabular-nums text-muted-foreground">
                        {p.imo} · {relativeAge(p.asOf)}
                      </span>
                    </span>
                  </button>
                );
              })
            ) : positions.length > 0 ? (
              // Filtered everything out — distinct from having no data at
              // all, and recoverable in one click.
              <div className="px-3 py-6 text-center">
                <p className="text-xs text-muted-foreground">No vessels match this filter.</p>
                <Button
                  size="xs"
                  variant="outline"
                  className="mt-2"
                  onClick={() => {
                    setSearch('');
                    setStatusFilter(null);
                  }}
                >
                  Clear filters
                </Button>
              </div>
            ) : (
              <p className="px-3 py-6 text-center text-xs text-muted-foreground">
                No vessels have a plottable position yet — a vessel appears here once one of its Log
                Abstract reports carries a Position (Latitude/Longitude).
              </p>
            )}
          </div>
        </div>
      )}

      {/* Zoom + fit sit bottom-right, clear of the panel and of Leaflet's
          attribution. Marker size has no control: it follows zoom. */}
      <div className="absolute bottom-6 right-3 z-[1000] flex flex-col gap-1.5">
        <button
          type="button"
          onClick={fitAll}
          disabled={filtered.length === 0}
          aria-label="Fit all vessels in view"
          title="Fit all vessels in view"
          className="rounded-lg border border-border bg-card/95 p-2 text-foreground shadow-lg backdrop-blur-sm transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-40"
        >
          <Crosshair className="size-4" />
        </button>
        <div className="flex flex-col overflow-hidden rounded-lg border border-border bg-card/95 shadow-lg backdrop-blur-sm">
          <button
            type="button"
            onClick={() => mapRef.current?.zoomIn()}
            aria-label="Zoom in"
            className="px-2 py-1.5 text-sm font-medium leading-none text-foreground transition-colors hover:bg-muted"
          >
            +
          </button>
          <div className="h-px bg-border" />
          <button
            type="button"
            onClick={() => mapRef.current?.zoomOut()}
            aria-label="Zoom out"
            className="px-2 py-1.5 text-sm font-medium leading-none text-foreground transition-colors hover:bg-muted"
          >
            −
          </button>
        </div>
      </div>
    </div>
  );
}
