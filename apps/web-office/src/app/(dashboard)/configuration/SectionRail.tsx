"use client";

import { useMemo } from "react";
import type { SchemaField } from "@/lib/config/fieldPolicyLogic";

// Plain <div>/<button> markup, no shared UI-kit wrapper — same discipline
// as the table markup in FieldPolicyTab.tsx (see the notes there): this
// rail sits right next to the 400+ row virtualized table and has no
// reason to pull in anything that could grow shared, aria-driven styling
// later.
export function SectionRail({
  fields,
  sections,
  sectionFilter,
  onSelect,
  impact,
}: {
  fields: SchemaField[];
  sections: string[];
  sectionFilter: string | null;
  onSelect: (section: string | null) => void;
  impact: { total: number; bySection: Record<string, number> };
}) {
  const totalsBySection = useMemo(() => {
    const out: Record<string, number> = {};
    for (const f of fields) out[f.section] = (out[f.section] ?? 0) + 1;
    return out;
  }, [fields]);

  return (
    <div className="w-56 shrink-0 rounded-md border border-border bg-card p-2 overflow-y-auto">
      <div className="flex items-center justify-between px-2 py-1.5 text-xs uppercase tracking-wider text-muted-foreground font-semibold">
        <span>Section</span>
        <span>Total · Visible</span>
      </div>
      <SectionRow
        label="All sections"
        active={sectionFilter === null}
        onClick={() => onSelect(null)}
        total={fields.length}
        visible={impact.total}
      />
      {sections.map((section) => (
        <SectionRow
          key={section}
          label={section}
          active={sectionFilter === section}
          onClick={() => onSelect(section)}
          total={totalsBySection[section] ?? 0}
          visible={impact.bySection[section] ?? 0}
        />
      ))}
    </div>
  );
}

function SectionRow({
  label,
  active,
  onClick,
  total,
  visible,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  total: number;
  visible: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full flex items-center justify-between gap-2 rounded-md px-2 py-2 text-left text-sm mb-0.5 cursor-pointer ${
        active ? "bg-status-info/10 text-status-info" : "text-foreground hover:bg-muted/50"
      }`}
    >
      <span className="truncate">{label}</span>
      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
        {total} <span className="text-xs">· {visible}</span>
      </span>
    </button>
  );
}
