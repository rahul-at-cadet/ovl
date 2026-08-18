"use client";

import { useMemo } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { Scope, ScopeType } from "@/lib/config/complianceLogic";

interface VesselLike {
  id: string;
  name: string;
  groups?: string[] | null;
}

interface ScopeSelectorProps {
  scope: Scope;
  onChange: (scope: Scope) => void;
  vessels: VesselLike[];
  allowFleet?: boolean;
}

/**
 * Fleet / vessel-group / single-vessel picker shared by every panel that
 * edits scope-partitioned configuration (field policy, regulatory
 * profiles, cadence rules, rule severities, bundle assignment). Ports
 * ovl/web/office/src/screens/configuration/ScopeSelector.tsx.
 */
export function ScopeSelector({ scope, onChange, vessels, allowFleet = true }: ScopeSelectorProps) {
  const groups = useMemo(() => {
    const set = new Set<string>();
    for (const v of vessels) for (const g of v.groups ?? []) set.add(g);
    return [...set].sort();
  }, [vessels]);

  const typeOptions: ScopeType[] = allowFleet ? ["fleet", "group", "vessel"] : ["group", "vessel"];
  const typeLabels: Record<ScopeType, string> = {
    fleet: "Fleet-wide",
    group: "Vessel Group",
    vessel: "Specific Vessel",
  };

  return (
    <div className="flex items-end gap-4">
      <div className="space-y-1">
        <label className="text-xs text-slate-400 uppercase font-semibold tracking-wider">Scope</label>
        <Select
          value={scope.type}
          onValueChange={(val: any) => {
            if (!val) return;
            onChange(val === "fleet" ? { type: "fleet" } : { type: val as ScopeType, key: "" });
          }}
        >
          <SelectTrigger className="w-40 bg-slate-950 border-slate-800">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {typeOptions.map((t) => (
              <SelectItem key={t} value={t}>
                {typeLabels[t]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {scope.type === "group" && (
        <div className="space-y-1">
          <label className="text-xs text-slate-400 uppercase font-semibold tracking-wider">Group</label>
          <Select value={scope.key || ""} onValueChange={(val: any) => val && onChange({ type: "group", key: val })}>
            <SelectTrigger className="w-48 bg-slate-950 border-slate-800">
              <SelectValue placeholder={groups.length ? "Select group" : "No groups defined"} />
            </SelectTrigger>
            <SelectContent>
              {groups.map((g) => (
                <SelectItem key={g} value={g}>
                  {g}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {scope.type === "vessel" && (
        <div className="space-y-1">
          <label className="text-xs text-slate-400 uppercase font-semibold tracking-wider">Vessel</label>
          <Select value={scope.key || ""} onValueChange={(val: any) => val && onChange({ type: "vessel", key: val })}>
            <SelectTrigger className="w-56 bg-slate-950 border-slate-800">
              <SelectValue placeholder={vessels.length ? "Select vessel" : "No vessels"} />
            </SelectTrigger>
            <SelectContent>
              {vessels.map((v) => (
                <SelectItem key={v.id} value={v.id}>
                  {v.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
    </div>
  );
}
