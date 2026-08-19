"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { X, Check } from "lucide-react";
import { POLICY_STATES, PREFILL_CLASSES } from "@/lib/config/fieldPolicyLogic";

// Native <select>s for state/prefill, same as the per-row Policy State /
// Prefill controls in FieldPolicyTab.tsx — this toolbar mounts a handful
// of controls (not one per row), but stays consistent with the rest of
// this screen's discipline of avoiding the shared Select component here.
// The events control below is the one exception: a *multiple* native
// <select> renders as a tall scrollable listbox rather than a compact
// dropdown, which broke this toolbar's single-line layout, so it uses the
// same compact button+popover pattern as the per-row EventsCell instead.
export function BulkActionsToolbar({
  selectedCount,
  editableCount,
  eventful,
  eventTypes,
  onApplyState,
  onApplyPrefill,
  onApplyEvents,
  onClear,
}: {
  selectedCount: number;
  editableCount: number;
  eventful: boolean;
  eventTypes: string[];
  onApplyState: (state: string) => void;
  onApplyPrefill: (cls: string) => void;
  onApplyEvents: (events: string[]) => void;
  onClear: () => void;
}) {
  const [bulkState, setBulkState] = useState("optional");
  const [bulkPrefill, setBulkPrefill] = useState("none");
  const [bulkEvents, setBulkEvents] = useState<string[]>([]);
  const [notice, setNotice] = useState<{ text: string; id: number } | null>(null);

  useEffect(() => {
    if (!notice) return undefined;
    const t = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(t);
  }, [notice]);

  function notify(text: string) {
    setNotice({ text, id: Date.now() });
  }

  const plural = editableCount === 1 ? "field" : "fields";

  return (
    <div
      role="toolbar"
      aria-label={`Bulk actions for ${selectedCount} selected fields`}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClear();
      }}
      className="flex flex-wrap items-center gap-3.5 rounded-md border border-border border-l-[3px] border-l-blue-500 bg-muted/40 px-3.5 py-2.5"
    >
      <div className="flex items-center gap-1">
        <span className="text-sm font-medium tabular-nums whitespace-nowrap">{selectedCount} selected</span>
        <Button variant="ghost" size="sm" onClick={onClear}>
          <X className="w-3.5 h-3.5" /> Clear
        </Button>
      </div>

      <Divider />

      <div className="flex items-center gap-2">
        <select
          value={bulkState}
          onChange={(e) => setBulkState(e.target.value)}
          className="h-8 rounded-md border border-border bg-background text-xs px-2 text-foreground"
        >
          {POLICY_STATES.filter((s) => s.value !== "schemaMandatory").map((s) => (
            <option key={s.value} value={s.value}>{s.label}</option>
          ))}
        </select>
        <Button
          size="sm"
          onClick={() => {
            onApplyState(bulkState);
            notify(`State set to ${bulkState} on ${editableCount} ${plural}`);
          }}
        >
          Apply
        </Button>
      </div>

      <Divider />

      <div className="flex items-center gap-2">
        <select
          value={bulkPrefill}
          onChange={(e) => setBulkPrefill(e.target.value)}
          className="h-8 rounded-md border border-border bg-background text-xs px-2 text-foreground"
        >
          {PREFILL_CLASSES.map((v) => (
            <option key={v} value={v}>{v}</option>
          ))}
        </select>
        <Button
          size="sm"
          onClick={() => {
            onApplyPrefill(bulkPrefill);
            notify(`Prefill set to ${bulkPrefill} on ${selectedCount} ${selectedCount === 1 ? "field" : "fields"}`);
          }}
        >
          Apply
        </Button>
      </div>

      {eventful && (
        <>
          <Divider />
          <div className="flex items-center gap-2">
            <BulkEventsPicker eventTypes={eventTypes} value={bulkEvents} onChange={setBulkEvents} />
            <Button
              size="sm"
              onClick={() => {
                onApplyEvents(bulkEvents);
                const scopeLabel = bulkEvents.length === 0 ? "all events" : bulkEvents.join(", ");
                notify(`Applies-to set to ${scopeLabel} on ${editableCount} ${plural}`);
              }}
            >
              Apply
            </Button>
          </div>
        </>
      )}

      {notice && (
        <div role="status" aria-live="polite" className="ml-auto flex items-center gap-1.5 text-xs text-blue-400">
          <Check className="w-3.5 h-3.5" />
          {notice.text}
        </div>
      )}
    </div>
  );
}

function Divider() {
  return <span aria-hidden="true" className="w-px self-stretch min-h-8 bg-border shrink-0" />;
}

// Same button + outside-click-close popover pattern as FieldPolicyTab's
// EventsCell — deliberately not a <select multiple>, which renders as a
// tall scrollable listbox instead of a compact single-line trigger.
function BulkEventsPicker({
  eventTypes,
  value,
  onChange,
}: {
  eventTypes: string[];
  value: string[];
  onChange: (next: string[]) => void;
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

  const label = value.length === 0 ? "All events" : `${value.length} event${value.length === 1 ? "" : "s"}`;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="h-8 rounded-md border border-border bg-background text-xs px-2 text-foreground min-w-28 text-left"
      >
        {label}
      </button>
      {open && (
        <div className="absolute z-20 mt-1 max-h-64 w-48 overflow-y-auto rounded-md border border-border bg-popover p-2 shadow-md">
          <label className="flex items-center gap-2 text-xs text-foreground py-1">
            <input type="checkbox" checked={value.length === 0} onChange={() => onChange([])} />
            All events
          </label>
          {eventTypes.map((ev) => (
            <label key={ev} className="flex items-center gap-2 text-xs text-foreground py-1">
              <input
                type="checkbox"
                checked={value.includes(ev)}
                onChange={() => {
                  const set = new Set(value);
                  if (set.has(ev)) set.delete(ev);
                  else set.add(ev);
                  onChange([...set]);
                }}
              />
              {ev}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
