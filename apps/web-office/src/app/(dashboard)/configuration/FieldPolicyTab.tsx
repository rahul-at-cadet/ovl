"use client";

import { useState, useMemo, useEffect } from "react";
import { trpc } from "@/lib/trpc";
import { 
  useReactTable, 
  getCoreRowModel, 
  getFilteredRowModel,
  flexRender, 
  createColumnHelper
} from "@tanstack/react-table";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
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

  const { data: policyData, isLoading: policyLoading, refetch: refetchPolicy } = trpc.fieldPolicies.get.useQuery(
    { 
      schemaName: selectedSchema, 
      scopeType: scope.type,
      scopeKey: scope.key
    },
    { enabled: !!selectedSchema }
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
    if (policyData) {
      setPolicyOverrides(policyData.policy || {});
      setPrefillOverrides(policyData.prefill || {});
      setEventsOverrides(policyData.events || {});
    }
  }, [policyData]);

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

  const columnHelper = createColumnHelper<SchemaField>();
  const columns = [
    columnHelper.accessor('name', {
      header: 'Field Name',
      cell: info => (
        <div>
          <div className="font-medium">{info.row.original.label || info.getValue()}</div>
          <div className="text-xs text-slate-500 font-mono">{info.getValue()}</div>
        </div>
      ),
    }),
    columnHelper.accessor('section', {
      header: 'Section',
      cell: info => <Badge variant="secondary">{info.getValue()}</Badge>
    }),
    columnHelper.accessor(row => effectiveState(row, policyOverrides, eventsOverrides), {
      id: 'state',
      header: 'Policy State',
      cell: info => {
        const field = info.row.original;
        const currentEffective = info.getValue();
        const explicit = policyOverrides[field.name];
        
        return (
          <Select 
            value={explicit || "inherit"} 
            disabled={field.schemaMandatory}
            onValueChange={val => {
              if (!val) return;
              const newOverrides = { ...policyOverrides };
              if (val === "inherit") {
                delete newOverrides[field.name];
              } else {
                newOverrides[field.name] = val;
              }
              setPolicyOverrides(newOverrides);
            }}
          >
            <SelectTrigger className={`w-32 ${explicit ? 'border-blue-500 bg-blue-500/10 text-blue-300' : ''}`}>
              <SelectValue placeholder={
                POLICY_STATES.find(s => s.value === currentEffective)?.label || currentEffective
              } />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="inherit" className="italic text-slate-400">
                Inherit ({POLICY_STATES.find(s => s.value === effectiveState(field, {}))?.label})
              </SelectItem>
              {POLICY_STATES.map(s => (
                <SelectItem key={s.value} value={s.value} disabled={s.value === "schemaMandatory" && !field.schemaMandatory}>
                  {s.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )
      }
    }),
    ...(eventTypes.length > 0
      ? [
          columnHelper.display({
            id: 'events',
            header: 'Applies To',
            cell: (info: any) => {
              const field = info.row.original as SchemaField;
              const selectedEvents = eventsOverrides[field.name] ?? [];
              const disabled = field.schemaMandatory;
              const label = selectedEvents.length === 0 ? 'All events' : `${selectedEvents.length} event${selectedEvents.length === 1 ? '' : 's'}`;
              return (
                <Popover>
                  <PopoverTrigger
                    disabled={disabled}
                    className={`text-xs rounded-md border px-2 py-1 ${
                      selectedEvents.length > 0
                        ? 'border-blue-500 bg-blue-500/10 text-blue-300'
                        : 'border-slate-800 text-slate-400'
                    } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
                  >
                    {label}
                  </PopoverTrigger>
                  <PopoverContent className="max-h-64 overflow-y-auto">
                    <label className="flex items-center gap-2 text-xs text-slate-300 py-1">
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
                      <label key={ev} className="flex items-center gap-2 text-xs text-slate-300 py-1">
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
                  </PopoverContent>
                </Popover>
              );
            },
          }),
        ]
      : []),
    columnHelper.accessor(row => effectivePrefill(row, prefillOverrides), {
      id: 'prefill',
      header: 'Prefill Behavior',
      cell: info => {
        const field = info.row.original;
        const currentEffective = info.getValue();
        const explicit = prefillOverrides[field.name];
        
        return (
          <Select 
            value={explicit || "inherit"} 
            onValueChange={val => {
              if (!val) return;
              const newOverrides = { ...prefillOverrides };
              if (val === "inherit") {
                delete newOverrides[field.name];
              } else {
                newOverrides[field.name] = val;
              }
              setPrefillOverrides(newOverrides);
            }}
          >
            <SelectTrigger className={`w-36 ${explicit ? 'border-blue-500 bg-blue-500/10 text-blue-300' : ''}`}>
              <SelectValue placeholder={currentEffective} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="inherit" className="italic text-slate-400">
                Inherit (none)
              </SelectItem>
              {PREFILL_CLASSES.map(s => (
                <SelectItem key={s} value={s}>{s}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )
      }
    })
  ];

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

  return (
    <div className="space-y-6">
      <Card className="bg-slate-900 border-slate-800">
        <CardContent className="p-6">
          <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
            <div className="flex items-center gap-4">
              <div className="space-y-1">
                <label className="text-xs text-slate-400 uppercase font-semibold tracking-wider">Schema</label>
                <Select value={selectedSchema} onValueChange={(val) => setSelectedSchema(val || "")} disabled={schemasLoading}>
                  <SelectTrigger className="w-48 bg-slate-950 border-slate-800">
                    <SelectValue placeholder="Select Schema" />
                  </SelectTrigger>
                  <SelectContent>
                    {schemas?.map(s => (
                      <SelectItem key={s.schemaName} value={s.schemaName}>{s.schemaName}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <ScopeSelector scope={scope} onChange={setScope} vessels={vessels as any} />
            </div>

            <Button 
              onClick={handleSave} 
              disabled={!isDirty || savePolicy.isPending}
              className={isDirty ? "bg-blue-600 hover:bg-blue-700 text-white" : "bg-slate-800 text-slate-400"}
            >
              {savePolicy.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
              {isDirty ? "Save Changes" : "Up to Date"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {policyData?.migration && (
        <div className="rounded-md border border-amber-900/50 bg-amber-950/30 px-4 py-3 text-sm text-amber-300 flex items-start gap-2">
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
        <p className="text-xs text-slate-500">
          Overrides also exist for {overridesElsewhere.length} other scope{overridesElsewhere.length === 1 ? "" : "s"} on this schema.
        </p>
      )}

      <Card className="bg-slate-900 border-slate-800">
        <CardHeader className="flex flex-row items-center justify-between py-4 border-b border-slate-800">
          <CardTitle className="text-lg">Field Requirements Matrix</CardTitle>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
            <Input 
              placeholder="Search fields..." 
              value={search}
              onChange={e => setSearch(e.target.value || "")}
              className="pl-9 w-64 bg-slate-950 border-slate-800"
            />
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {policyLoading ? (
            <div className="p-12 text-center text-slate-500 flex flex-col items-center">
              <Loader2 className="w-8 h-8 animate-spin mb-4" />
              <p>Loading schema policy matrix...</p>
            </div>
          ) : fields.length === 0 ? (
            <div className="p-12 text-center text-slate-500">
              <p>No fields found in this schema version.</p>
            </div>
          ) : (
            <div className="rounded-md border border-slate-800 overflow-hidden m-4">
              <Table>
                <TableHeader className="bg-slate-950/50">
                  {table.getHeaderGroups().map(headerGroup => (
                    <TableRow key={headerGroup.id} className="border-slate-800 hover:bg-transparent">
                      {headerGroup.headers.map(header => (
                        <TableHead key={header.id} className="font-semibold text-slate-300">
                          {header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
                        </TableHead>
                      ))}
                    </TableRow>
                  ))}
                </TableHeader>
                <TableBody>
                  {table.getRowModel().rows?.length ? (
                    table.getRowModel().rows.map(row => (
                      <TableRow key={row.id} data-state={row.getIsSelected() && "selected"} className="border-slate-800 hover:bg-slate-800/50">
                        {row.getVisibleCells().map(cell => (
                          <TableCell key={cell.id} className="py-3">
                            {flexRender(cell.column.columnDef.cell, cell.getContext())}
                          </TableCell>
                        ))}
                      </TableRow>
                    ))
                  ) : (
                    <TableRow>
                      <TableCell colSpan={columns.length} className="h-24 text-center text-slate-500">
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
