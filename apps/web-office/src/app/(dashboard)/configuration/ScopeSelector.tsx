"use client";

import { useMemo } from "react";
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

  // Native <select> elements rather than the Select component: this picker
  // sits directly above the Field Policy tab's large virtualized table, and
  // mounting/unmounting a Base UI Select's floating tree in that context
  // was hanging the whole tab (a runaway re-render loop, not just jank).
  // Fluid, not fixed. This picker is used both on the full-width Field Policy
  // tab and inside the "Assign a Bundle" dialog, so hard widths (w-40 + w-56 +
  // a 16px gap = 400px) overflowed the narrower container and, once wrapped,
  // left ragged rows of mismatched selects. Each field now grows to share the
  // row, is capped so it never stretches absurdly wide on the full-width tab,
  // and wraps to its own line only when the container is genuinely too narrow.
  return (
    <div className="flex flex-wrap items-end gap-4">
      <div className="space-y-1 flex-1 min-w-[9rem] max-w-[15rem]">
        <label className="text-xs text-muted-foreground uppercase font-semibold tracking-wider">Scope</label>
        <select
          value={scope.type}
          onChange={(e) => {
            const val = e.target.value as ScopeType;
            onChange(val === "fleet" ? { type: "fleet" } : { type: val, key: "" });
          }}
          className="w-full bg-background border border-border text-foreground rounded-md h-9 px-2 text-sm"
        >
          {typeOptions.map((t) => (
            <option key={t} value={t}>
              {typeLabels[t]}
            </option>
          ))}
        </select>
      </div>

      {scope.type === "group" && (
        <div className="space-y-1 flex-1 min-w-[9rem] max-w-[15rem]">
          <label className="text-xs text-muted-foreground uppercase font-semibold tracking-wider">Group</label>
          <select
            value={scope.key || ""}
            onChange={(e) => e.target.value && onChange({ type: "group", key: e.target.value })}
            className="w-full bg-background border border-border text-foreground rounded-md h-9 px-2 text-sm"
          >
            <option value="" disabled>
              {groups.length ? "Select group" : "No groups defined"}
            </option>
            {groups.map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
          </select>
        </div>
      )}

      {scope.type === "vessel" && (
        <div className="space-y-1 flex-1 min-w-[9rem] max-w-[15rem]">
          <label className="text-xs text-muted-foreground uppercase font-semibold tracking-wider">Vessel</label>
          <select
            value={scope.key || ""}
            onChange={(e) => e.target.value && onChange({ type: "vessel", key: e.target.value })}
            className="w-full bg-background border border-border text-foreground rounded-md h-9 px-2 text-sm"
          >
            <option value="" disabled>
              {vessels.length ? "Select vessel" : "No vessels"}
            </option>
            {vessels.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}
