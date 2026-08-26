"use client";

import { useState, useMemo, useEffect, useRef, useDeferredValue, useCallback, type CSSProperties } from "react";
import { trpc } from "@/lib/trpc";
import {
  useReactTable,
  getCoreRowModel,
  flexRender,
  createColumnHelper,
  type Row,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Card, CardContent, CardHeader, CardTitle } from "@ovl/ui/components/card";
import { Input } from "@ovl/ui/components/input";
import { Button } from "@ovl/ui/components/button";
import { Badge } from "@ovl/ui/components/badge";
import { Loader2, Search, Save, CalendarClock } from "lucide-react";

import {
  POLICY_STATES,
  PREFILL_CLASSES,
  effectiveState,
  effectivePrefill,
  visibleFieldCount,
  sectionsInOrder,
  SchemaField,
} from "@/lib/config/fieldPolicyLogic";
import { scopesEqual, scopeLabel, type Scope } from "@/lib/config/complianceLogic";
import { ScopeSelector } from "./ScopeSelector";
import { SectionRail } from "./SectionRail";
import { BulkActionsToolbar } from "./BulkActionsToolbar";

// Stable references for the "no data yet" case — not `[]` inline at the
// call site. `policyData?.fields || []` looks harmless but allocates a
// brand-new array every render whenever policyData is undefined (e.g.
// scope is "Vessel Group"/"Specific Vessel" with no key chosen yet, which
// disables the query for as long as the user is on that screen). That
// unstable reference flows into useReactTable's `data` option, and
// react-table's own reconciliation reacts to `data` changing identity by
// re-rendering — which recomputes `fields` as yet another new array,
// forever. Since nothing about that state ever resolves on its own, the
// loop never terminates: this was the actual cause of the schema/scope
// "whole tab hangs" reports, not virtualization or any UI library.
const EMPTY_FIELDS: SchemaField[] = [];
const EMPTY_EVENT_TYPES: string[] = [];
const EMPTY_VESSELS: { id: string; name: string; groups?: string[] | null }[] = [];
const EMPTY_ASSIGNMENTS: { scope: unknown }[] = [];

// This cell, the table markup below, and the row/table components it uses
// are all plain HTML with no shared UI-kit wrapper and no ARIA attributes —
// deliberately, since a `:has([aria-...])` selector on the shared table row
// component turned out to be the cause of a severe hang on this screen's
// 400+ row virtualized table (see table.tsx history), and a Base UI Select
// caused a second, separate hang (see the notes on the native <select>s
// below). Every other tRPC-backed screen in this app can use the shared
// UI kit freely; this one specifically can't, because it's the only place
// in the codebase that ever mounts controls for 400+ rows at once.
//
// Proof this table doesn't need to be virtualized to *survive* 409 rows —
// only to feel smooth — lives in the pre-migration version of this same
// screen: ovl/web/office/src/screens/configuration/FieldPolicyScreen.tsx
// renders all 409 rows as plain <tr>s with no virtualization at all, and
// has never hung, because its per-row controls are the same
// button+popover pattern EventsCell uses below rather than a floating-ui
// library. Virtualization here is defense-in-depth on top of that, not
// the load-bearing fix — the load-bearing fix is staying off heavy
// shared component libraries in this hot path.
function EventsCell({
  field,
  selectedEvents,
  eventTypes,
  onToggleAll,
  onToggleEvent,
}: {
  field: SchemaField;
  selectedEvents: string[];
  eventTypes: string[];
  onToggleAll: () => void;
  onToggleEvent: (ev: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const disabled = field.schemaMandatory;
  const label = selectedEvents.length === 0 ? "All events" : `${selectedEvents.length} event${selectedEvents.length === 1 ? "" : "s"}`;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className={`text-xs rounded-md border px-2 py-1 cursor-pointer inline-block ${
          selectedEvents.length > 0 ? "border-status-info/25 bg-status-info/10 text-status-info" : "border-border text-muted-foreground"
        } ${disabled ? "opacity-50 pointer-events-none" : ""}`}
      >
        {label}
      </button>
      {open && (
        <div className="absolute z-20 mt-1 max-h-64 w-48 overflow-y-auto rounded-md border border-border bg-popover p-2 shadow-md">
          <label className="flex items-center gap-2 text-xs text-foreground py-1">
            <input type="checkbox" checked={selectedEvents.length === 0} onChange={onToggleAll} />
            All events
          </label>
          {eventTypes.map((ev) => (
            <label key={ev} className="flex items-center gap-2 text-xs text-foreground py-1">
              <input type="checkbox" checked={selectedEvents.includes(ev)} onChange={() => onToggleEvent(ev)} />
              {ev}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

// Field Name is the one column that identifies which row you're looking
// at, so it (and the checkbox beside it) stay pinned to the left while
// the rest of the row scrolls horizontally — at six columns wide, this
// table doesn't fit most viewports, and without this a click on a
// right-hand control (e.g. focusing a Prefill <select>) can auto-scroll
// the row's identity clean out of view.
const STICKY_LEFT: Record<string, number> = { select: 0, name: 36 };
function stickyCellStyle(columnId: string, width: number): CSSProperties {
  const left = STICKY_LEFT[columnId];
  if (left === undefined) return { width };
  return { width, position: "sticky", left, zIndex: 1 };
}

// One entry in the virtualized list: either a real field row, or a
// section-divider row inserted between runs of same-section field rows
// (only while the section rail is on "All sections" — a single-section
// filter needs no dividers since there's only one section on screen).
// Both kinds share the virtualizer's row-height estimate, so the divider
// itself is padded to match rather than measured, keeping the virtualizer
// on a single fixed estimateSize with no per-row measurement needed.
type VirtualRowEntry =
  | { kind: "divider"; key: string; section: string }
  | { kind: "field"; key: string; row: Row<SchemaField> };

export function FieldPolicyTab() {
  const { data: schemas, isLoading: schemasLoading } = trpc.schemas.list.useQuery();
  const { data: vessels = EMPTY_VESSELS } = trpc.vessels.list.useQuery();
  const [selectedSchema, setSelectedSchema] = useState<string>("");
  const [scope, setScope] = useState<Scope>({ type: "fleet" });

  // Set default schema once loaded
  useEffect(() => {
    if (schemas?.length && !selectedSchema) {
      setSelectedSchema(schemas[0].schemaName);
    }
  }, [schemas, selectedSchema]);

  // A group/vessel scope isn't usable until a specific key is picked — until
  // then, don't fetch. Otherwise this fires immediately with an empty key
  // the instant the scope *type* changes, and the backend's scope filter
  // (which requires a non-empty key to apply) ends up matching whatever
  // arbitrary group/vessel row happens to exist for this schema instead of
  // nothing.
  const scopeReady = scope.type === "fleet" || !!scope.key;

  // Memoized so the query input has a stable reference across renders —
  // passing a fresh object literal here made the query observer treat every
  // render as "the input changed," restarting the fetch before it could ever
  // complete. That starved the actual network request indefinitely while
  // each restart's state update triggered another render, which triggered
  // another restart: a tight render loop with zero real fetches going out.
  const fieldPoliciesGetInput = useMemo(
    () => ({ schemaName: selectedSchema, scopeType: scope.type, scopeKey: scope.key }),
    [selectedSchema, scope.type, scope.key]
  );
  const fieldPoliciesGetOptions = useMemo(
    () => ({ enabled: !!selectedSchema && scopeReady }),
    [selectedSchema, scopeReady]
  );
  const { data: policyData, isLoading: policyLoading, refetch: refetchPolicy } = trpc.fieldPolicies.get.useQuery(
    fieldPoliciesGetInput,
    fieldPoliciesGetOptions
  );

  const savePolicy = trpc.fieldPolicies.save.useMutation({
    onSuccess: () => {
      refetchPolicy();
      refetchAssignments();
    }
  });

  const listAssignmentsInput = useMemo(() => ({ schemaName: selectedSchema }), [selectedSchema]);
  const listAssignmentsOptions = useMemo(() => ({ enabled: !!selectedSchema }), [selectedSchema]);
  const { data: assignments = EMPTY_ASSIGNMENTS, refetch: refetchAssignments } = trpc.fieldPolicies.listAssignments.useQuery(
    listAssignmentsInput,
    listAssignmentsOptions,
  );
  const overridesElsewhere = assignments.filter((a) => !scopesEqual(a.scope as Scope, scope));

  const [policyOverrides, setPolicyOverrides] = useState<Record<string, string>>({});
  const [prefillOverrides, setPrefillOverrides] = useState<Record<string, string>>({});
  const [eventsOverrides, setEventsOverrides] = useState<Record<string, string[]>>({});
  const [search, setSearch] = useState("");
  // The <input> below stays bound to `search` directly so every keystroke
  // is instant; only the expensive part — refiltering up to 409 fields and
  // rebuilding the table's row model — reads the deferred value, so React
  // can let that lag a render behind on a big schema without the input
  // itself ever feeling laggy.
  const deferredSearch = useDeferredValue(search);
  const [sectionFilter, setSectionFilter] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [reviewed, setReviewed] = useState<Set<string>>(new Set());

  // Sync state when policy data loads
  useEffect(() => {
    if (!scopeReady) {
      setPolicyOverrides({});
      setPrefillOverrides({});
      setEventsOverrides({});
      return;
    }
    if (policyData) {
      setPolicyOverrides(policyData.policy || {});
      setPrefillOverrides(policyData.prefill || {});
      setEventsOverrides(policyData.events || {});
    }
  }, [policyData, scopeReady]);

  // A schema or scope switch invalidates row selection, migration-review
  // marks, and the section filter — all keyed on primitive deps (never the
  // `scope` object itself) so this only fires on a genuine change, not on
  // every render.
  useEffect(() => {
    setSelected(new Set());
    setReviewed(new Set());
    setSectionFilter(null);
  }, [selectedSchema, scope.type, scope.key]);

  const isDirty = useMemo(() => {
    if (!policyData) return false;
    // A pending migration proposal counts as dirty even before any field is
    // touched, so Save has something to persist instead of sitting forever.
    return (
      policyData.migration != null ||
      JSON.stringify(policyOverrides) !== JSON.stringify(policyData.policy || {}) ||
      JSON.stringify(prefillOverrides) !== JSON.stringify(policyData.prefill || {}) ||
      JSON.stringify(eventsOverrides) !== JSON.stringify(policyData.events || {})
    );
  }, [policyData, policyOverrides, prefillOverrides, eventsOverrides]);

  const handleSave = async () => {
    if (!selectedSchema) return;
    await savePolicy.mutateAsync({
      schemaName: selectedSchema,
      scopeType: scope.type,
      scopeKey: scope.key,
      policy: policyOverrides,
      prefill: prefillOverrides,
      events: eventsOverrides,
    });
  };

  const fields: SchemaField[] = policyData?.fields ?? EMPTY_FIELDS;
  const eventTypes: string[] = policyData?.eventTypes ?? EMPTY_EVENT_TYPES;
  const eventful = eventTypes.length > 0;
  const migration = policyData?.migration;

  const fieldsByName = useMemo(() => new Map(fields.map((f) => [f.name, f])), [fields]);

  const sections = useMemo(() => sectionsInOrder(fields), [fields]);
  const impact = useMemo(
    () => visibleFieldCount(fields, policyOverrides, eventsOverrides),
    [fields, policyOverrides, eventsOverrides]
  );

  const visibleFields = useMemo(() => {
    const q = deferredSearch.trim().toLowerCase();
    return fields.filter((f) => {
      if (sectionFilter && f.section !== sectionFilter) return false;
      if (q && !f.name.toLowerCase().includes(q) && !(f.label && f.label.toLowerCase().includes(q))) return false;
      return true;
    });
  }, [fields, deferredSearch, sectionFilter]);

  // Bulk actions and the header "select all" only ever touch fields
  // actually on screen, and never a schemaMandatory one (the schema
  // decides, not the company — same rule the per-row controls enforce).
  const selectableVisibleNames = useMemo(
    () => visibleFields.filter((f) => !f.schemaMandatory).map((f) => f.name),
    [visibleFields]
  );
  const allVisibleSelected = selectableVisibleNames.length > 0 && selectableVisibleNames.every((n) => selected.has(n));
  const editableSelectionSize = useMemo(
    () => [...selected].filter((name) => !fieldsByName.get(name)?.schemaMandatory).length,
    [selected, fieldsByName]
  );

  const toggleSelectAllVisible = useCallback(() => {
    setSelected((prev) => {
      const next = new Set(prev);
      const shouldSelect = !(selectableVisibleNames.length > 0 && selectableVisibleNames.every((n) => next.has(n)));
      for (const name of selectableVisibleNames) {
        if (shouldSelect) next.add(name);
        else next.delete(name);
      }
      return next;
    });
  }, [selectableVisibleNames]);

  const toggleFieldSelected = useCallback((name: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  const applyBulkState = useCallback((state: string) => {
    setPolicyOverrides((prev) => {
      const next = { ...prev };
      for (const name of selected) {
        if (fieldsByName.get(name)?.schemaMandatory) continue;
        next[name] = state;
      }
      return next;
    });
  }, [selected, fieldsByName]);

  const applyBulkPrefill = useCallback((cls: string) => {
    setPrefillOverrides((prev) => {
      const next = { ...prev };
      for (const name of selected) {
        if (cls === "none") delete next[name];
        else next[name] = cls;
      }
      return next;
    });
  }, [selected]);

  const applyBulkEvents = useCallback((events: string[]) => {
    setEventsOverrides((prev) => {
      const next = { ...prev };
      for (const name of selected) {
        if (fieldsByName.get(name)?.schemaMandatory) continue;
        if (events.length === 0) delete next[name];
        else next[name] = events;
      }
      return next;
    });
  }, [selected, fieldsByName]);

  const columnHelper = useMemo(() => createColumnHelper<SchemaField>(), []);
  const columns = useMemo(() => [
    columnHelper.display({
      id: 'select',
      size: 36,
      header: () => (
        <input
          type="checkbox"
          checked={allVisibleSelected}
          onChange={toggleSelectAllVisible}
          aria-label="Select all visible fields"
        />
      ),
      cell: info => {
        const field = info.row.original;
        if (field.schemaMandatory) return null;
        return (
          <input
            type="checkbox"
            checked={selected.has(field.name)}
            onChange={() => toggleFieldSelected(field.name)}
            aria-label={`Select ${field.label || field.name}`}
          />
        );
      },
    }),
    columnHelper.accessor('name', {
      header: 'Field Name',
      size: 320,
      cell: info => {
        const field = info.row.original;
        const isNew = migration?.newFields.includes(field.name) ?? false;
        return (
          <div>
            <div className="font-medium flex items-center gap-2">
              <span>{field.label || info.getValue()}</span>
              {isNew && (
                <button
                  type="button"
                  onClick={() => setReviewed(prev => {
                    const next = new Set(prev);
                    if (next.has(field.name)) next.delete(field.name);
                    else next.add(field.name);
                    return next;
                  })}
                  className={`text-xs px-1.5 py-0.5 rounded-full cursor-pointer whitespace-nowrap ${
                    reviewed.has(field.name)
                      ? "bg-status-ok/10 text-status-ok"
                      : "bg-status-warn/10 text-status-warn"
                  }`}
                >
                  {reviewed.has(field.name) ? "Reviewed" : "New — review"}
                </button>
              )}
            </div>
            <div className="text-xs text-muted-foreground font-mono">{info.getValue()}</div>
          </div>
        );
      },
    }),
    columnHelper.accessor('section', {
      header: 'Section',
      size: 140,
      cell: info => <Badge variant="secondary">{info.getValue()}</Badge>
    }),
    columnHelper.accessor(row => effectiveState(row, policyOverrides, eventsOverrides), {
      id: 'state',
      header: 'Policy State',
      size: 160,
      cell: info => {
        const field = info.row.original;
        const explicit = policyOverrides[field.name];

        // A plain <select> here rather than the Select component: with a
        // 400+ row virtualized table, mounting dozens of Base UI Select
        // instances at once (each registered in its shared floating-element
        // tree) made every interaction on the page — including unrelated
        // ones, like the scope picker above the table — grind to a halt.
        // Native selects have no such coordination overhead.
        return (
          <select
            value={explicit || "inherit"}
            disabled={field.schemaMandatory}
            onChange={e => {
              const val = e.target.value;
              const newOverrides = { ...policyOverrides };
              if (val === "inherit") {
                delete newOverrides[field.name];
              } else {
                newOverrides[field.name] = val;
              }
              setPolicyOverrides(newOverrides);
            }}
            className={`w-32 h-8 rounded-md border bg-background text-xs px-2 disabled:opacity-50 disabled:cursor-not-allowed ${explicit ? 'border-status-info/25 bg-status-info/10 text-status-info' : 'border-border text-foreground'}`}
          >
            <option value="inherit">
              Inherit ({POLICY_STATES.find(s => s.value === effectiveState(field, {}))?.label})
            </option>
            {POLICY_STATES.map(s => (
              <option key={s.value} value={s.value} disabled={s.value === "schemaMandatory" && !field.schemaMandatory}>
                {s.label}
              </option>
            ))}
          </select>
        )
      }
    }),
    ...(eventful
      ? [
          columnHelper.display({
            id: 'events',
            header: 'Applies To',
            size: 160,
            cell: (info: any) => {
              const field = info.row.original as SchemaField;
              const selectedEvents = eventsOverrides[field.name] ?? [];
              return (
                <EventsCell
                  field={field}
                  selectedEvents={selectedEvents}
                  eventTypes={eventTypes}
                  onToggleAll={() => {
                    const next = { ...eventsOverrides };
                    delete next[field.name];
                    setEventsOverrides(next);
                  }}
                  onToggleEvent={(ev) => {
                    const next = { ...eventsOverrides };
                    const list = new Set(selectedEvents);
                    if (list.has(ev)) list.delete(ev);
                    else list.add(ev);
                    if (list.size === 0) delete next[field.name];
                    else next[field.name] = [...list];
                    setEventsOverrides(next);
                  }}
                />
              );
            },
          }),
        ]
      : []),
    columnHelper.accessor(row => effectivePrefill(row, prefillOverrides), {
      id: 'prefill',
      header: 'Prefill Behavior',
      size: 180,
      cell: info => {
        const field = info.row.original;
        const explicit = prefillOverrides[field.name];

        return (
          <select
            value={explicit || "inherit"}
            onChange={e => {
              const val = e.target.value;
              const newOverrides = { ...prefillOverrides };
              if (val === "inherit") {
                delete newOverrides[field.name];
              } else {
                newOverrides[field.name] = val;
              }
              setPrefillOverrides(newOverrides);
            }}
            className={`w-36 h-8 rounded-md border bg-background text-xs px-2 ${explicit ? 'border-status-info/25 bg-status-info/10 text-status-info' : 'border-border text-foreground'}`}
          >
            <option value="inherit">Inherit (none)</option>
            {PREFILL_CLASSES.map(s => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        )
      }
    })
  ], [columnHelper, policyOverrides, prefillOverrides, eventsOverrides, eventTypes, eventful, migration, reviewed, selected, allVisibleSelected, toggleSelectAllVisible, toggleFieldSelected]);

  const table = useReactTable({
    data: visibleFields,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getRowId: row => row.name,
  });

  // Schemas here run to 400+ fields; rendering every row's Select/Popover
  // controls at once made the tab unresponsive. Only the rows actually in
  // (or near) the viewport get mounted.
  const tableContainerRef = useRef<HTMLDivElement>(null);
  const { rows } = table.getRowModel();

  // Section-divider entries only get interleaved in the "All sections"
  // view — a single-section filter already shows one section, so there's
  // nothing to divide. `fields` (and therefore `visibleFields`, which
  // preserves its order) is already section-grouped by the schema itself,
  // so a single pass suffices — no sorting needed.
  const virtualEntries: VirtualRowEntry[] = useMemo(() => {
    if (sectionFilter) {
      return rows.map(row => ({ kind: "field" as const, key: row.id, row }));
    }
    const out: VirtualRowEntry[] = [];
    let lastSection: string | undefined;
    for (const row of rows) {
      if (row.original.section !== lastSection) {
        lastSection = row.original.section;
        // Keyed by position, not just section name: a schema's fields
        // aren't guaranteed to keep every section's rows in one
        // contiguous run (log-abstract's 409 fields revisit "header" and
        // "voyage" later in the list), so two divider entries can share a
        // section name — a key derived only from that name would collide.
        out.push({ kind: "divider" as const, key: `divider:${out.length}:${lastSection}`, section: lastSection });
      }
      out.push({ kind: "field" as const, key: row.id, row });
    }
    return out;
  }, [rows, sectionFilter]);

  // A stable callback, not a fresh arrow function per render: no reason to
  // hand @tanstack/react-virtual a new function identity on every commit
  // when a ref access needs no closed-over values to change.
  const getScrollElement = useCallback(() => tableContainerRef.current, []);
  const rowVirtualizer = useVirtualizer({
    count: virtualEntries.length,
    getScrollElement,
    estimateSize: () => 57,
    overscan: 12,
  });
  const virtualItems = rowVirtualizer.getVirtualItems();
  const totalHeight = rowVirtualizer.getTotalSize();
  const paddingTop = virtualItems.length > 0 ? virtualItems[0].start : 0;
  const paddingBottom = virtualItems.length > 0 ? totalHeight - virtualItems[virtualItems.length - 1].end : 0;

  return (
    <div className="space-y-6">
      <Card className="bg-card border-border">
        <CardContent className="p-6">
          <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
            <div className="flex items-center gap-4">
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground uppercase font-semibold tracking-wider">Schema</label>
                {/* Native <select>, not the Select component: this sits directly
                    above the 400+ row virtualized Field Policy table, and the
                    Base UI Select's floating tree hung the whole tab on change
                    (same root cause as the scope picker below). */}
                <select
                  value={selectedSchema}
                  onChange={(e) => setSelectedSchema(e.target.value || "")}
                  disabled={schemasLoading}
                  className="w-48 bg-background border border-border text-foreground rounded-md h-9 px-2 text-sm disabled:opacity-50"
                >
                  {!selectedSchema && <option value="" disabled>Select Schema</option>}
                  {schemas?.map(s => (
                    <option key={s.schemaName} value={s.schemaName}>{s.schemaName}</option>
                  ))}
                </select>
              </div>

              <ScopeSelector scope={scope} onChange={setScope} vessels={vessels as any} />
            </div>

            <Button
              onClick={handleSave}
              disabled={!isDirty || savePolicy.isPending}
              className={isDirty ? undefined : "bg-muted text-muted-foreground"}
            >
              {savePolicy.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
              {isDirty ? "Save Changes" : "Up to Date"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {migration && (
        <div className="rounded-md border border-status-warn/30 bg-status-warn/10 px-4 py-3 text-sm text-status-warn flex items-start gap-2">
          <CalendarClock className="w-4 h-4 mt-0.5 shrink-0" />
          <div>
            Migrating field policy from v{migration.fromVersion} to v{policyData?.version} —{" "}
            {migration.newFields.length} new field{migration.newFields.length === 1 ? "" : "s"},{" "}
            {migration.removedFields.length} removed field{migration.removedFields.length === 1 ? "" : "s"}.
            Review and save to persist this proposed carry-forward.
          </div>
        </div>
      )}

      {overridesElsewhere.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Overrides also exist for: {overridesElsewhere.map(a => scopeLabel(a.scope as Scope, vessels as any)).join(", ")}
        </p>
      )}

      <Card className="bg-card border-border">
        <CardHeader className="flex flex-row items-center justify-between py-4 border-b border-border">
          <CardTitle className="text-lg">Field Requirements Matrix</CardTitle>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              placeholder="Search fields..."
              value={search}
              onChange={e => setSearch(e.target.value || "")}
              className="pl-9 w-64 bg-background border-border"
            />
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {/* The scroll container below stays mounted unconditionally —
              only what's inside it swaps between a status message and the
              table — so tableContainerRef always has a real element for
              useVirtualizer to measure, instead of going null whenever
              scope is "Vessel Group"/"Specific Vessel" with no key chosen
              yet (which disables the fields query and would otherwise hide
              this div). The schema/scope render-loop hang itself had a
              different cause: see EMPTY_FIELDS/EMPTY_EVENT_TYPES above. */}
          <div className="flex gap-4 p-4">
            <SectionRail
              fields={fields}
              sections={sections}
              sectionFilter={sectionFilter}
              onSelect={setSectionFilter}
              impact={impact}
            />

            <div className="flex-1 min-w-0 space-y-3">
              {selected.size > 0 && (
                <BulkActionsToolbar
                  selectedCount={selected.size}
                  editableCount={editableSelectionSize}
                  eventful={eventful}
                  eventTypes={eventTypes}
                  onApplyState={applyBulkState}
                  onApplyPrefill={applyBulkPrefill}
                  onApplyEvents={applyBulkEvents}
                  onClear={() => setSelected(new Set())}
                />
              )}

              <div ref={tableContainerRef} className="rounded-md border border-border overflow-auto max-h-[70vh]">
                {!scopeReady ? (
                  <div className="p-12 text-center text-muted-foreground">
                    <p>Select a {scope.type} to view and edit its field policy.</p>
                  </div>
                ) : policyLoading ? (
                  <div className="p-12 text-center text-muted-foreground flex flex-col items-center">
                    <Loader2 className="w-8 h-8 animate-spin mb-4" />
                    <p>Loading schema policy matrix...</p>
                  </div>
                ) : fields.length === 0 ? (
                  <div className="p-12 text-center text-muted-foreground">
                    <p>No fields found in this schema version.</p>
                  </div>
                ) : (
                  /* Plain <table>/<tr>/<td>, not the shared Table components: see
                     the note above EventsCell — this screen stays fully clear of
                     any shared styling that could reintroduce the same class of
                     bug. */
                  <table className="w-full caption-bottom text-sm">
                    {/* Solid background, not bg-background/50: a translucent
                        sticky header lets scrolled-under row text bleed
                        through and visually collide with the header labels
                        once there's enough content to actually scroll (easy
                        to miss on a short table, obvious at 409 rows). */}
                    <thead className="bg-card sticky top-0 z-10">
                      {table.getHeaderGroups().map(headerGroup => (
                        <tr key={headerGroup.id} className="border-b border-border">
                          {headerGroup.headers.map(header => {
                            const pinned = header.column.id in STICKY_LEFT;
                            return (
                              <th
                                key={header.id}
                                style={pinned ? { ...stickyCellStyle(header.column.id, header.getSize()), zIndex: 20 } : { width: header.getSize() }}
                                className={`h-10 px-2 text-left align-middle font-semibold text-foreground whitespace-nowrap ${pinned ? "bg-card" : ""} ${header.column.id === "name" ? "border-r border-border" : ""}`}
                              >
                                {header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
                              </th>
                            );
                          })}
                        </tr>
                      ))}
                    </thead>
                    <tbody>
                      {virtualEntries.length ? (
                        <>
                          {paddingTop > 0 && (
                            <tr>
                              <td colSpan={columns.length} style={{ height: paddingTop }} />
                            </tr>
                          )}
                          {virtualItems.map(virtualItem => {
                            const entry = virtualEntries[virtualItem.index];
                            if (entry.kind === "divider") {
                              return (
                                <tr key={entry.key}>
                                  <td
                                    colSpan={columns.length}
                                    className="h-[57px] px-2 align-middle bg-muted/30 text-xs font-semibold uppercase tracking-wider text-muted-foreground"
                                  >
                                    {entry.section}
                                  </td>
                                </tr>
                              );
                            }
                            const row = entry.row;
                            return (
                              <tr key={entry.key} className="border-b border-border hover:bg-muted/50">
                                {row.getVisibleCells().map(cell => {
                                  const pinned = cell.column.id in STICKY_LEFT;
                                  return (
                                    <td
                                      key={cell.id}
                                      style={stickyCellStyle(cell.column.id, cell.column.getSize())}
                                      className={`p-2 py-3 align-middle whitespace-nowrap ${pinned ? "bg-card" : ""} ${cell.column.id === "name" ? "border-r border-border" : ""}`}
                                    >
                                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                                    </td>
                                  );
                                })}
                              </tr>
                            );
                          })}
                          {paddingBottom > 0 && (
                            <tr>
                              <td colSpan={columns.length} style={{ height: paddingBottom }} />
                            </tr>
                          )}
                        </>
                      ) : (
                        <tr>
                          <td colSpan={columns.length} className="h-24 text-center text-muted-foreground">
                            No fields match your search.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                )}
              </div>

              <div className="flex items-center justify-end text-xs text-muted-foreground">
                v{policyData?.version} · {fields.length} fields
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
