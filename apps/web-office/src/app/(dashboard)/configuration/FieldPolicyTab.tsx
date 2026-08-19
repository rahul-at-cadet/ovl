"use client";

import { useState, useMemo, useEffect, useRef } from "react";
import { trpc } from "@/lib/trpc";
import {
  useReactTable,
  getCoreRowModel,
  getFilteredRowModel,
  flexRender,
  createColumnHelper
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2, Search, Save, CalendarClock } from "lucide-react";

import {
  POLICY_STATES,
  PREFILL_CLASSES,
  effectiveState,
  effectivePrefill,
  SchemaField
} from "@/lib/config/fieldPolicyLogic";
import { scopesEqual, type Scope } from "@/lib/config/complianceLogic";
import { ScopeSelector } from "./ScopeSelector";

export function FieldPolicyTab() {
  const { data: schemas, isLoading: schemasLoading } = trpc.schemas.list.useQuery();
  const { data: vessels = [] } = trpc.vessels.list.useQuery();
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

  const { data: policyData, isLoading: policyLoading, refetch: refetchPolicy } = trpc.fieldPolicies.get.useQuery(
    {
      schemaName: selectedSchema,
      scopeType: scope.type,
      scopeKey: scope.key
    },
    { enabled: !!selectedSchema && scopeReady }
  );

  const savePolicy = trpc.fieldPolicies.save.useMutation({
    onSuccess: () => {
      refetchPolicy();
      refetchAssignments();
    }
  });

  const { data: assignments = [], refetch: refetchAssignments } = trpc.fieldPolicies.listAssignments.useQuery(
    { schemaName: selectedSchema },
    { enabled: !!selectedSchema },
  );
  const overridesElsewhere = assignments.filter((a) => !scopesEqual(a.scope as Scope, scope));

  const [policyOverrides, setPolicyOverrides] = useState<Record<string, string>>({});
  const [prefillOverrides, setPrefillOverrides] = useState<Record<string, string>>({});
  const [eventsOverrides, setEventsOverrides] = useState<Record<string, string[]>>({});
  const [search, setSearch] = useState("");

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

  const fields = policyData?.fields || [];
  const eventTypes = policyData?.eventTypes || [];

  const columnHelper = useMemo(() => createColumnHelper<SchemaField>(), []);
  const columns = useMemo(() => [
    columnHelper.accessor('name', {
      header: 'Field Name',
      size: 320,
      cell: info => (
        <div>
          <div className="font-medium">{info.row.original.label || info.getValue()}</div>
          <div className="text-xs text-muted-foreground font-mono">{info.getValue()}</div>
        </div>
      ),
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
        const currentEffective = info.getValue();
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
            className={`w-32 h-8 rounded-md border bg-background text-xs px-2 disabled:opacity-50 disabled:cursor-not-allowed ${explicit ? 'border-blue-500 bg-blue-500/10 text-blue-300' : 'border-border text-foreground'}`}
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
    ...(eventTypes.length > 0
      ? [
          columnHelper.display({
            id: 'events',
            header: 'Applies To',
            size: 160,
            cell: (info: any) => {
              const field = info.row.original as SchemaField;
              const selectedEvents = eventsOverrides[field.name] ?? [];
              const disabled = field.schemaMandatory;
              const label = selectedEvents.length === 0 ? 'All events' : `${selectedEvents.length} event${selectedEvents.length === 1 ? '' : 's'}`;
              // A native <details> disclosure instead of the Popover component —
              // same floating-element-overhead reasoning as the selects above.
              return (
                <details className="relative">
                  <summary
                    className={`list-none text-xs rounded-md border px-2 py-1 cursor-pointer inline-block ${
                      selectedEvents.length > 0
                        ? 'border-blue-500 bg-blue-500/10 text-blue-300'
                        : 'border-border text-muted-foreground'
                    } ${disabled ? 'opacity-50 pointer-events-none' : ''}`}
                  >
                    {label}
                  </summary>
                  <div className="absolute z-20 mt-1 max-h-64 w-48 overflow-y-auto rounded-md border border-border bg-popover p-2 shadow-md">
                    <label className="flex items-center gap-2 text-xs text-foreground py-1">
                      <input
                        type="checkbox"
                        checked={selectedEvents.length === 0}
                        onChange={() => {
                          const next = { ...eventsOverrides };
                          delete next[field.name];
                          setEventsOverrides(next);
                        }}
                      />
                      All events
                    </label>
                    {eventTypes.map((ev) => (
                      <label key={ev} className="flex items-center gap-2 text-xs text-foreground py-1">
                        <input
                          type="checkbox"
                          checked={selectedEvents.includes(ev)}
                          onChange={() => {
                            const next = { ...eventsOverrides };
                            const list = new Set(selectedEvents);
                            if (list.has(ev)) list.delete(ev);
                            else list.add(ev);
                            if (list.size === 0) delete next[field.name];
                            else next[field.name] = [...list];
                            setEventsOverrides(next);
                          }}
                        />
                        {ev}
                      </label>
                    ))}
                  </div>
                </details>
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
            className={`w-36 h-8 rounded-md border bg-background text-xs px-2 ${explicit ? 'border-blue-500 bg-blue-500/10 text-blue-300' : 'border-border text-foreground'}`}
          >
            <option value="inherit">Inherit (none)</option>
            {PREFILL_CLASSES.map(s => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        )
      }
    })
  ], [columnHelper, policyOverrides, prefillOverrides, eventsOverrides, eventTypes]);

  const table = useReactTable({
    data: fields,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    state: {
      globalFilter: search,
    },
    onGlobalFilterChange: setSearch,
    globalFilterFn: (row: any, columnId: string, filterValue: any) => {
      const q = (filterValue as string).toLowerCase();
      const f = row.original as SchemaField;
      return !!(f.name.toLowerCase().includes(q) || (f.label && f.label.toLowerCase().includes(q)));
    }
  });

  // Schemas here run to 400+ fields; rendering every row's Select/Popover
  // controls at once made the tab unresponsive. Only the rows actually in
  // (or near) the viewport get mounted.
  const tableContainerRef = useRef<HTMLDivElement>(null);
  const { rows } = table.getRowModel();
  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => tableContainerRef.current,
    estimateSize: () => 57,
    overscan: 12,
  });
  const virtualRows = rowVirtualizer.getVirtualItems();
  const totalHeight = rowVirtualizer.getTotalSize();
  const paddingTop = virtualRows.length > 0 ? virtualRows[0].start : 0;
  const paddingBottom = virtualRows.length > 0 ? totalHeight - virtualRows[virtualRows.length - 1].end : 0;

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
              className={isDirty ? "bg-blue-600 hover:bg-blue-700 text-white" : "bg-muted text-muted-foreground"}
            >
              {savePolicy.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
              {isDirty ? "Save Changes" : "Up to Date"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {policyData?.migration && (
        <div className="rounded-md border border-amber-300 bg-amber-50 dark:border-amber-900/50 dark:bg-amber-950/30 px-4 py-3 text-sm text-amber-700 dark:text-amber-300 flex items-start gap-2">
          <CalendarClock className="w-4 h-4 mt-0.5 shrink-0" />
          <div>
            Migrating field policy from v{policyData.migration.fromVersion} to v{policyData.version} —{" "}
            {policyData.migration.newFields.length} new field{policyData.migration.newFields.length === 1 ? "" : "s"},{" "}
            {policyData.migration.removedFields.length} removed field{policyData.migration.removedFields.length === 1 ? "" : "s"}.
            Review and save to persist this proposed carry-forward.
          </div>
        </div>
      )}

      {overridesElsewhere.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Overrides also exist for {overridesElsewhere.length} other scope{overridesElsewhere.length === 1 ? "" : "s"} on this schema.
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
            <div ref={tableContainerRef} className="rounded-md border border-border overflow-auto m-4 max-h-[70vh]">
              <Table>
                <TableHeader className="bg-background/50 sticky top-0 z-10">
                  {table.getHeaderGroups().map(headerGroup => (
                    <TableRow key={headerGroup.id} className="border-border hover:bg-transparent">
                      {headerGroup.headers.map(header => (
                        <TableHead key={header.id} style={{ width: header.getSize() }} className="font-semibold text-foreground">
                          {header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
                        </TableHead>
                      ))}
                    </TableRow>
                  ))}
                </TableHeader>
                <TableBody>
                  {rows.length ? (
                    <>
                      {paddingTop > 0 && (
                        <tr>
                          <td colSpan={columns.length} style={{ height: paddingTop }} />
                        </tr>
                      )}
                      {virtualRows.map(virtualRow => {
                        const row = rows[virtualRow.index];
                        return (
                          <TableRow
                            key={row.id}
                            data-state={row.getIsSelected() && "selected"}
                            className="border-border hover:bg-muted/50"
                          >
                            {row.getVisibleCells().map(cell => (
                              <TableCell key={cell.id} style={{ width: cell.column.getSize() }} className="py-3">
                                {flexRender(cell.column.columnDef.cell, cell.getContext())}
                              </TableCell>
                            ))}
                          </TableRow>
                        );
                      })}
                      {paddingBottom > 0 && (
                        <tr>
                          <td colSpan={columns.length} style={{ height: paddingBottom }} />
                        </tr>
                      )}
                    </>
                  ) : (
                    <TableRow>
                      <TableCell colSpan={columns.length} className="h-24 text-center text-muted-foreground">
                        No fields match your search.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
