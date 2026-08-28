'use client';

import { useState, useEffect, useMemo, useRef, Fragment } from 'react';
import { useForm, Controller, useWatch } from 'react-hook-form';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@ovl/ui/components/card';
import { Button } from '@ovl/ui/components/button';
import { Input } from '@ovl/ui/components/input';
import { Label } from '@ovl/ui/components/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@ovl/ui/components/tabs';
import { AlertCircle, AlertTriangle, CheckCircle2, Circle, Save, Send, Loader2, Cpu, RotateCcw, Lock, LockOpen } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { trpc } from '@/lib/trpc';
import { useRouter } from 'next/navigation';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@ovl/ui/components/select';
import { AttachmentsSection } from './AttachmentsSection';
import { useToastManager } from '@ovl/ui/components/toast';
import { effectiveState, type SchemaField } from '@/lib/config/fieldPolicyLogic';
import { computeDerivedValues, computeTimeSincePreviousReport, DERIVED_FIELDS } from '@/lib/derivedFields';
import { PositionField } from './PositionField';
import { SaveStatus, type SaveState } from './SaveStatus';
import { useScrollActiveTabIntoView } from './ScrollableTabs';

// Degree/Minutes/Hemisphere triples rendered as one compound DMS
// control (see PositionField.tsx) instead of three unrelated plain
// number inputs. Keyed by the degree field's name; the minutes/
// hemisphere companions are consumed into the same control and never
// rendered on their own.
const POSITION_GROUPS: Record<string, { axis: 'lat' | 'lon'; label: string; minutes: string; hemisphere: string }> = {
  Latitude_Degree: { axis: 'lat', label: 'Latitude', minutes: 'Latitude_Minutes', hemisphere: 'Latitude_North_South' },
  Longitude_Degree: { axis: 'lon', label: 'Longitude', minutes: 'Longitude_Minutes', hemisphere: 'Longitude_East_West' },
};
const POSITION_CONSUMED_FIELDS = new Set(
  Object.values(POSITION_GROUPS).flatMap((g) => [g.minutes, g.hemisphere]),
);

/**
 * <input type="datetime-local"> serialises as "YYYY-MM-DDTHH:MM", but the
 * schema's dateTime rule wants "YYYY-MM-DD HH:MM" (see
 * apps/api-vessel/src/validation/field-rules.ts). Translating at the control's
 * edge keeps the stored value in the schema's format without touching the
 * validator.
 */
function dateTimeForServer(v: string): string {
  return v.includes('T') ? v.replace('T', ' ') : v;
}

function dateTimeForInput(v: string): string {
  return v.includes(' ') ? v.replace(' ', 'T') : v;
}

function isEventLockField(field: { name: string; enumRef?: string | null }): boolean {
  return field.name === 'Event' && field.enumRef === 'event-types';
}

interface ReportFormProps {
  reportId: string;
}

export function ReportForm({ reportId }: ReportFormProps) {
  const router = useRouter();
  const toastManager = useToastManager();
  const sectionTabsRef = useScrollActiveTabIntoView<HTMLDivElement>();
  const [serverErrors, setServerErrors] = useState<string[]>([]);
  // Which section tab is active, so Save/autosave persists the section the
  // user is actually looking at — this used to always write to sections[0]
  // regardless of the selected tab (see the section: sections[0] comment
  // this replaced), silently discarding edits to any other section on
  // every autosave tick.
  const [activeSection, setActiveSection] = useState<string | null>(null);

  // 1. Fetch Report Draft
  const { data: report, isLoading: isReportLoading, error: reportError } = trpc.reports.getReport.useQuery({
    id: reportId
  });

  // 2. Fetch Dynamic Schema
  const { data: schema, isLoading: isSchemaLoading, error: schemaError } = trpc.reports.getSchema.useQuery({
    schemaName: report?.schemaName || ''
  }, {
    enabled: !!report?.schemaName
  });

  const { data: telemetry, isLoading: telemetryLoading } = trpc.system.getTelemetry.useQuery(undefined, {
    enabled: !!schema,
  });

  // Field-level policy (hidden/optional/recommended/mandatory, per-event
  // narrowing) synced down from office in the config bundle — see
  // reports.getFieldPolicy's own comment for where this data comes from.
  // Hidden fields never render; mandatory ones get a required marker;
  // fields scoped to other event types than this report's own don't show.
  const { data: fieldPolicy } = trpc.reports.getFieldPolicy.useQuery(
    { schemaName: report?.schemaName || '' },
    { enabled: !!report?.schemaName }
  );
  const policy = fieldPolicy?.policy ?? {};
  const policyEvents = fieldPolicy?.events ?? {};

  // 3. Resolve curated enumRef fields (e.g. "fuel-types") to their real
  // codes, mirroring the original's api.getEnum(ref) — an enum field
  // with no resolvable enumRef (or an enumRef the registry doesn't know)
  // falls back to unrestricted text entry rather than an empty dropdown.
  const enumRefs = useMemo(
    () => [...new Set(
      (schema?.fields ?? [])
        .filter((f) => f.type === 'enum' && f.enumRef)
        .map((f) => f.enumRef as string)
    )],
    [schema]
  );
  const enumQueries = trpc.useQueries((t) =>
    enumRefs.map((ref) => t.reports.getEnum({ name: ref }))
  );
  const enumValuesByRef = useMemo(() => {
    const out: Record<string, string[]> = {};
    enumRefs.forEach((ref, i) => {
      out[ref] = enumQueries[i]?.data ?? [];
    });
    return out;
  }, [enumRefs, enumQueries]);

  const submitReportMutation = trpc.reports.submitReport.useMutation();
  // saveSection and check report through the panel and the save indicator
  // below rather than the global mutation toast — a toast per autosave tick
  // would be unreadable.
  const saveSectionMutation = trpc.reports.saveSection.useMutation({
    meta: { silentError: true },
  });
  const checkMutation = trpc.reports.check.useMutation({ meta: { silentError: true } });
  const trpcUtils = trpc.useUtils();

  // Finding acknowledgement (architecture 15): append-only, no
  // acknowledgements table — current state is derived by replaying
  // report_events for the latest finding_acknowledged event per
  // (ruleId, field), same as the original UI does.
  const { data: events = [] } = trpc.reports.listEvents.useQuery({ reportId }, { enabled: !!report });
  const acknowledgedFindings = useMemo(() => {
    const out = new Map<string, boolean>();
    for (const e of events) {
      if (e.type !== 'finding_acknowledged') continue;
      const detail = e.detail as { ruleId?: string; field?: string; acknowledged?: boolean } | null;
      if (!detail?.ruleId) continue;
      out.set(`${detail.ruleId}:${detail.field ?? ''}`, !!detail.acknowledged);
    }
    return out;
  }, [events]);
  const acknowledgeFindingMutation = trpc.reports.acknowledgeFinding.useMutation({
    onSuccess: () => trpcUtils.reports.listEvents.invalidate({ reportId }),
  });

  // Section soft-locking (architecture 9.5). No live-push transport
  // exists anywhere in this app, so this polls rather than streaming —
  // saveSection's own server-side check is the real backstop regardless
  // of how fresh this poll is; the tab-disabling below is just the UX
  // layer that keeps an officer from walking into a lock they'd only
  // find out about on save.
  const { data: me } = trpc.users.me.useQuery();
  const { data: locks = [] } = trpc.reports.listLocks.useQuery({ id: reportId }, { refetchInterval: 5000 });
  const { data: syncStatus } = trpc.sync.status.useQuery();
  const acquireLockMutation = trpc.reports.acquireLock.useMutation();
  const releaseLockMutation = trpc.reports.releaseLock.useMutation();
  const forceReleaseLockMutation = trpc.reports.forceReleaseLock.useMutation();
  const lockBySection = useMemo(() => new Map(locks.map((l) => [l.section, l])), [locks]);
  const isMaster = me?.role?.toLowerCase() === 'master';

  // Claims the active section on entry, renews it every 60s (well
  // inside the 5-minute TTL) while it stays active, and releases it —
  // via this same effect's cleanup — the moment the officer switches
  // tabs or leaves the page.
  useEffect(() => {
    if (!report || !schema) return;
    const section = activeSection ?? (schema.sections?.[0] || 'General');
    acquireLockMutation.mutate(
      { id: reportId, section },
      {
        onError: (err) => {
          toastManager.add({ title: 'Section locked', description: err.message, type: 'error' });
        },
      },
    );
    const interval = setInterval(() => {
      acquireLockMutation.mutate({ id: reportId, section });
    }, 60_000);
    return () => {
      clearInterval(interval);
      releaseLockMutation.mutate({ id: reportId, section });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSection, report, schema, reportId]);

  // The real backend Health Check result (field rules + plausibility +
  // continuity against the committed chain — see ReportsService.
  // checkReport). Cleared on every save, since a save always demotes the
  // report back to draft (see saveSection's own comment) — a stale
  // "all checks passed" carried over past new edits would be actively
  // misleading, not just outdated.
  const [checkResult, setCheckResult] = useState<{
    findings: { ruleId: string; severity: 'error' | 'warning' | 'info'; field?: string; message: string }[];
    regulatoryReadiness: { profile: string; ready: boolean; missingFields: string[] }[];
    continuityImpact: { reportId: string; eventType: string; eventTime: string; invalidatedRules: string[] }[];
  } | null>(null);
  // Snapshot of form values at the moment checkResult was set. Staleness
  // is tied to an actual value change, not to "a save completed" — the
  // debounced autosave has its own independent timer that can land AFTER
  // handleRunCheck's own save+check sequence, and clearing on every save
  // success raced it into wiping a just-received result.
  const checkedValuesRef = useRef<string | null>(null);

  // Derived fields (compass sector, Beaufort force, time since previous
  // report) auto-fill from a sibling field or from report history —
  // see lib/derivedFields.ts's own doc comment on scope. A derived
  // field the officer has manually typed into stops auto-updating
  // until they explicitly restore it, same as any other computed
  // field elsewhere in this app.
  const [overriddenFields, setOverriddenFields] = useState<Set<string>>(new Set());
  const { data: sameSchemaReports } = trpc.reports.listReports.useQuery(
    { schemaName: report?.schemaName || '' },
    { enabled: !!report?.schemaName }
  );
  const lastReportEventTime = useMemo(() => {
    if (!sameSchemaReports || !report) return undefined;
    const submitted = sameSchemaReports
      .filter((r) => r.state === 'submitted' && r.reportId !== report.reportId && r.eventTime < report.eventTime)
      .sort((a, b) => (a.eventTime < b.eventTime ? 1 : -1));
    return submitted[0]?.eventTime;
  }, [sameSchemaReports, report]);

  const defaultValues = useMemo(() => {
    if (!schema || !report) return undefined;

    let parsedFields: Record<string, any> = {};
    if (typeof report.fields === 'string') {
      try {
        parsedFields = JSON.parse(report.fields);
      } catch (e) {
        console.error("Failed to parse report fields JSON", e);
      }
    } else if (report.fields) {
      parsedFields = report.fields as Record<string, any>;
    }

    const vals: Record<string, any> = {};
    schema.fields.forEach(f => {
      const existingVal = parsedFields[f.name];
      vals[f.name] = existingVal !== undefined ? existingVal : '';
    });
    return vals;
  }, [schema, report]);

  const { control, handleSubmit, reset, setValue, getValues } = useForm({
    values: defaultValues,
    resetOptions: {
      keepDirtyValues: true // Prevent background updates from wiping out user typing
    }
  });

  const formValues = useWatch({ control });
  // One stringify per value change, shared by the save indicator and the
  // Health Check staleness effect below — both need the same snapshot and
  // this form can carry 400+ fields.
  const formSnapshot = useMemo(() => JSON.stringify(formValues), [formValues]);

  // What the autosave is doing, and whether the officer has edits the last
  // completed save didn't include. `savedSnapshotRef` is written only from
  // mutation callbacks, and every write is paired with a setSaveState, so
  // reading it during render always sees a value the render was scheduled
  // for.
  const [saveState, setSaveState] = useState<SaveState>({ kind: 'idle' });
  const savedSnapshotRef = useRef<string | null>(null);
  const hasUnsavedEdits =
    savedSnapshotRef.current !== null && savedSnapshotRef.current !== formSnapshot;

  const derived = useMemo(() => {
    const combined = computeDerivedValues(formValues);
    const tsp = computeTimeSincePreviousReport(report?.eventTime, lastReportEventTime);
    if (tsp) combined['Time_Since_Previous_Report'] = tsp;
    return combined;
  }, [formValues, report, lastReportEventTime]);
  const liveComputedFields = useMemo(
    () => [...Object.keys(DERIVED_FIELDS), 'Time_Since_Previous_Report'],
    [],
  );
  useEffect(() => {
    for (const name of liveComputedFields) {
      if (overriddenFields.has(name)) continue;
      const result = derived[name];
      if (result && formValues[name] !== result.value) {
        setValue(name, result.value, { shouldDirty: true });
      }
    }
    // formValues is deliberately excluded — this effect writes into it,
    // and derived/liveComputedFields already change whenever a relevant
    // source field does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [derived, liveComputedFields, overriddenFields, setValue]);

  function handleRestoreComputed(name: string) {
    setOverriddenFields((prev) => {
      if (!prev.has(name)) return prev;
      const next = new Set(prev);
      next.delete(name);
      return next;
    });
    const result = derived[name];
    if (result) setValue(name, result.value, { shouldDirty: true, shouldValidate: true });
  }

  // Auto-save debounced effect
  useEffect(() => {
    if (!report || !schema || Object.keys(formValues).length === 0) return;
    if (savedSnapshotRef.current === null) savedSnapshotRef.current = formSnapshot;

    const timer = setTimeout(() => {
      handleAction(formValues as Record<string, unknown>, 'draft', true);
    }, 1500);

    return () => clearTimeout(timer);
  }, [formValues, report, schema]);

  // A save always demotes the report back to draft server-side, so a
  // Health Check result stops reflecting reality the moment the officer
  // actually changes something further — not whenever the next save
  // happens to land, which can race against handleRunCheck's own save
  // (the debounced autosave's independent timer can fire just after it).
  useEffect(() => {
    if (!checkResult || checkedValuesRef.current === null) return;
    if (formSnapshot !== checkedValuesRef.current) {
      setCheckResult(null);
      checkedValuesRef.current = null;
    }
  }, [formSnapshot, checkResult]);

  // A report part-written and unsaved is the one thing on this screen that
  // can't be recovered by reloading, so closing the tab has to ask first.
  useEffect(() => {
    if (!hasUnsavedEdits && saveState.kind !== 'failed') return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [hasUnsavedEdits, saveState.kind]);

  const handlePrefillSensors = () => {
    if (telemetry && schema) {
      const updates: Record<string, any> = {};

      schema.fields.forEach(f => {
        if (f.name.toLowerCase().includes('lat')) updates[f.name] = telemetry.gps.lat.toFixed(4);
        if (f.name.toLowerCase().includes('lon') || f.name.toLowerCase().includes('lng')) updates[f.name] = telemetry.gps.lng.toFixed(4);
        if (f.name.toLowerCase().includes('speed')) updates[f.name] = telemetry.gps.speedKnots.toFixed(1);
        if (f.name.toLowerCase().includes('rpm')) updates[f.name] = telemetry.engine.rpm.toString();
        if (f.name.toLowerCase().includes('temp')) updates[f.name] = telemetry.engine.temperatureCelsius.toFixed(1);
        if (f.name.toLowerCase().includes('wind')) updates[f.name] = telemetry.environment.windSpeedKnots.toFixed(1);
      });

      // Same matching as before; the change is that the officer is told what
      // actually happened rather than watching values silently appear.
      const applied: string[] = [];
      const skipped: string[] = [];
      Object.entries(updates).forEach(([key, value]) => {
        const current = (getValues() as Record<string, unknown>)[key];
        if (current !== undefined && current !== '' && current !== value) {
          skipped.push(key);
          return;
        }
        setValue(key, value, { shouldValidate: true, shouldDirty: true });
        applied.push(key);
      });

      toastManager.add({
        title: applied.length
          ? `Filled ${applied.length} field${applied.length === 1 ? '' : 's'} from sensors`
          : 'Nothing filled from sensors',
        description: skipped.length
          ? `${skipped.length} field${skipped.length === 1 ? '' : 's'} left alone because they already hold a different value: ${skipped.slice(0, 4).join(', ')}${skipped.length > 4 ? '…' : ''}`
          : applied.length
            ? 'Existing values were left untouched.'
            : 'No matching fields were empty.',
        type: applied.length ? 'success' : 'info',
      });
      return;
    }
    toastManager.add({
      title: 'Sensor data unavailable',
      description: 'The local sensor source did not return a reading. Enter values manually.',
      type: 'warning',
    });
  };

  if (isReportLoading || isSchemaLoading) {
    return (
      <div className="flex flex-col items-center justify-center h-64 text-muted-foreground">
        <Loader2 className="w-8 h-8 animate-spin text-primary mb-4" />
        <p>Loading draft...</p>
      </div>
    );
  }

  if (reportError || !report || schemaError || !schema) {
    return (
      <div className="flex flex-col items-center justify-center h-64 text-status-critical">
        <AlertCircle className="w-8 h-8 mb-4" />
        <p>Failed to load draft: {reportError?.message || schemaError?.message}</p>
      </div>
    );
  }

  const handleAction = (data: Record<string, unknown>, action: 'draft' | 'submit', isAutoSave = false) => {
    setServerErrors([]);

    // Convert numeric fields based on schema definition
    const parsedFields: Record<string, unknown> = {};
    schema.fields.forEach(field => {
      const val = data[field.name];
      if (val === undefined) return; // Untouched field, leave it

      if (val === '') {
        parsedFields[field.name] = ''; // Explicit clear
        return;
      }

      if (field.type === 'wholeNumber' || field.type === 'decimal') {
        parsedFields[field.name] = Number(val);
      } else if (field.type === 'dateTime') {
        parsedFields[field.name] = dateTimeForServer(String(val));
      } else if (field.type === 'boolean') {
        parsedFields[field.name] = val === 'true' || val === true;
      } else {
        parsedFields[field.name] = val;
      }
    });

    if (action === 'submit') {
      submitReportMutation.mutate({ id: reportId }, {
        onSuccess: () => {
          trpcUtils.reports.getReport.invalidate({ id: reportId });
          trpcUtils.reports.listReports.invalidate();
          toastManager.add({ title: 'Report submitted', description: 'Submitted to shore.', type: 'success' });
        },
        onError: (err) => setServerErrors([err.message])
      });
    } else {
      // Find current active section based on the DOM, or just save all as 'General'
      // In a robust implementation, we would track the active tab state
      const snapshotAtSave = JSON.stringify(data);
      setSaveState({ kind: 'saving' });
      saveSectionMutation.mutate({
        id: reportId,
        section: activeSection ?? sections[0],
        changes: parsedFields
      }, {
        onSuccess: () => {
          savedSnapshotRef.current = snapshotAtSave;
          setSaveState({ kind: 'saved', at: new Date() });
          if (!isAutoSave) {
            trpcUtils.reports.getReport.invalidate({ id: reportId });
          }
          trpcUtils.reports.listReports.invalidate();
        },
        onError: (err) => {
          // An autosave failure used to be dropped on the floor here. It is
          // the *more* important one to show, not the less: the officer
          // didn't ask for it, so they have no reason to be watching for it.
          setSaveState({ kind: 'failed', message: err.message });
        }
      });
    }
  };

  const sections = schema.sections || ['General'];

  // Section a finding's field lives in, for click-to-jump — mirrors the
  // same fallback the form's own field rendering uses (section ||
  // sections[0]) so a finding always resolves to a real tab.
  // Per-section counts for the tab indicators. Plain derivation rather than a
  // hook: `sections` only exists after the loading/error returns above, so a
  // useMemo here would be a conditionally-called hook.
  const sectionSummary = (section: string) => {
    let missingRequired = 0;
    for (const f of schema.fields) {
      if ((f.section || sections[0]) !== section) continue;
      const state = effectiveState(
        { ...f, section: f.section || section, relevance: f.relevance || '' } as SchemaField,
        policy,
        policyEvents,
        report?.eventType,
      );
      if (state !== 'schemaMandatory' && state !== 'companyMandatory') continue;
      const v = (formValues as Record<string, unknown>)[f.name];
      if (v === undefined || v === null || v === '') missingRequired += 1;
    }
    const findings = checkResult?.findings ?? [];
    return {
      missingRequired,
      errors: findings.filter((x) => x.severity === 'error' && sectionForField(x.field) === section).length,
      warnings: findings.filter((x) => x.severity === 'warning' && sectionForField(x.field) === section).length,
    };
  };

  const sectionForField = (fieldName: string | undefined) => {
    if (!fieldName) return sections[0];
    return schema.fields.find((f) => f.name === fieldName)?.section || sections[0];
  };

  // Runs the real backend Health Check (field rules + plausibility +
  // continuity against the committed chain) — the only path to `ready`,
  // which submitReport now requires. Saves first (awaited, not fired
  // alongside) so the check runs against the officer's latest edits
  // rather than whatever was last auto-saved up to 1.5s ago.
  const handleRunCheck = async () => {
    setServerErrors([]);
    const data = getValues();
    const parsedFields: Record<string, unknown> = {};
    schema.fields.forEach((field) => {
      const val = data[field.name];
      if (val === undefined) return;
      if (val === '') { parsedFields[field.name] = ''; return; }
      if (field.type === 'wholeNumber' || field.type === 'decimal') parsedFields[field.name] = Number(val);
      else if (field.type === 'dateTime') parsedFields[field.name] = dateTimeForServer(String(val));
      else if (field.type === 'boolean') parsedFields[field.name] = val === 'true' || val === true;
      else parsedFields[field.name] = val;
    });

    try {
      const snapshotAtSave = JSON.stringify(data);
      setSaveState({ kind: 'saving' });
      await saveSectionMutation.mutateAsync({ id: reportId, section: activeSection ?? sections[0], changes: parsedFields });
      savedSnapshotRef.current = snapshotAtSave;
      setSaveState({ kind: 'saved', at: new Date() });
      trpcUtils.reports.listReports.invalidate();
      const result = await checkMutation.mutateAsync({ id: reportId });
      checkedValuesRef.current = JSON.stringify(getValues());
      setCheckResult(result);
      trpcUtils.reports.getReport.invalidate({ id: reportId });
    } catch (err: any) {
      setSaveState({ kind: 'failed', message: err.message });
      setServerErrors([err.message]);
    }
  };

  const canSubmit = report.state === 'ready';

  return (
    <div className="flex flex-col 2xl:flex-row gap-4 items-stretch 2xl:items-start 2xl:h-[calc(100vh_-_140px)] 2xl:overflow-hidden">
      {/* Form Area */}
      <div className="flex-1 w-full space-y-6 2xl:h-full 2xl:min-h-0 flex flex-col">
        <div className="flex flex-col lg:flex-row lg:justify-between lg:items-center gap-3 bg-card p-4 rounded-sm border border-border shrink-0">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
            <h2 className="text-xl font-bold tracking-tight text-foreground whitespace-nowrap">Drafting: {schema.schemaName}</h2>
            <SaveStatus
              state={saveState}
              hasUnsavedEdits={hasUnsavedEdits}
              pendingSync={syncStatus?.pendingCount}
              onRetry={() => handleAction(getValues(), 'draft')}
            />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 lg:flex gap-2">
            <Button type="button" size="sm" onClick={() => handleAction(getValues(), 'draft')} variant="outline" className="justify-center" disabled={saveSectionMutation.isPending || submitReportMutation.isPending}>
              <Save className="w-4 h-4 mr-1.5" />
              {saveSectionMutation.isPending ? 'Saving...' : 'Save Draft'}
            </Button>
            <Button type="button" size="sm" onClick={handleRunCheck} variant="outline" className="justify-center" disabled={checkMutation.isPending || submitReportMutation.isPending}>
              <CheckCircle2 className="w-4 h-4 mr-1.5" />
              {checkMutation.isPending ? 'Checking...' : 'Run Health Check'}
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={handleSubmit((d) => handleAction(d, 'submit'))}
              className="justify-center"
              disabled={saveSectionMutation.isPending || submitReportMutation.isPending || !canSubmit}
              title={canSubmit ? undefined : 'Run Health Check with zero errors before submitting'}
            >
              <Send className="w-4 h-4 mr-1.5" />
              {submitReportMutation.isPending ? 'Processing...' : 'Submit to Shore'}
            </Button>
          </div>
        </div>

        <Card className="bg-card border-border rounded-sm 2xl:flex-1 2xl:min-h-0 flex flex-col">
          <div className="px-4 pt-4 pb-3 flex flex-col sm:flex-row sm:justify-between sm:items-center gap-3 shrink-0">
            <h3 className="text-sm font-medium text-muted-foreground">Form Details</h3>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="w-full sm:w-auto justify-center"
              onClick={handlePrefillSensors}
              disabled={telemetryLoading || !telemetry}
            >
              <Cpu className="w-3 h-3 mr-2" />
              {telemetryLoading ? 'Reading Sensors...' : 'Pre-fill from Sensors'}
            </Button>
          </div>
          <Tabs value={activeSection ?? sections[0]} onValueChange={setActiveSection} className="w-full 2xl:flex-1 2xl:min-h-0 flex flex-col">
            {sections.length > 1 && (
              <div className="border-b border-border shrink-0 scroll-x">
                <TabsList ref={sectionTabsRef} className="bg-transparent w-full justify-start h-auto p-0 gap-0 rounded-none">
                  {sections.map(section => {
                    const lock = lockBySection.get(section);
                    const lockedByOther = !!lock && lock.userId !== me?.id;
                    const summary = sectionSummary(section);
                    return (
                      <Fragment key={section}>
                        <TabsTrigger
                          value={section}
                          disabled={lockedByOther && !isMaster}
                          title={lockedByOther ? `Locked by ${lock.username}` : undefined}
                          className="relative !flex-none rounded-none border-0 bg-transparent text-muted-foreground px-4 min-h-12 capitalize whitespace-nowrap
                            hover:bg-surface-hover
                            data-active:bg-surface-active data-active:text-foreground data-active:font-semibold data-active:shadow-none
                            after:absolute after:inset-x-0 after:-bottom-px after:h-[2px] after:bg-transparent data-active:after:bg-primary"
                        >
                          {lockedByOther && <Lock className="w-3.5 h-3.5 mr-1.5 shrink-0" aria-hidden="true" />}
                          {section.replace(/([A-Z])/g, ' $1').trim()}
                          {summary.errors > 0 ? (
                            <span
                              className="ml-2 inline-flex items-center gap-1 text-xs font-semibold text-status-critical"
                              title={`${summary.errors} error${summary.errors === 1 ? '' : 's'}`}
                            >
                              <AlertCircle className="w-3.5 h-3.5" aria-hidden="true" />
                              {summary.errors}
                              <span className="sr-only">errors</span>
                            </span>
                          ) : summary.missingRequired > 0 ? (
                            <span
                              className="ml-2 inline-flex items-center gap-1 text-xs font-semibold text-status-warn"
                              title={`${summary.missingRequired} required field${summary.missingRequired === 1 ? '' : 's'} outstanding`}
                            >
                              <Circle className="w-3.5 h-3.5" aria-hidden="true" />
                              {summary.missingRequired}
                              <span className="sr-only">required fields outstanding</span>
                            </span>
                          ) : summary.warnings > 0 ? (
                            <span
                              className="ml-2 inline-flex items-center gap-1 text-xs font-semibold text-status-warn"
                              title={`${summary.warnings} warning${summary.warnings === 1 ? '' : 's'}`}
                            >
                              <AlertTriangle className="w-3.5 h-3.5" aria-hidden="true" />
                              {summary.warnings}
                              <span className="sr-only">warnings</span>
                            </span>
                          ) : (
                            <CheckCircle2
                              className="ml-2 w-3.5 h-3.5 text-status-ok shrink-0"
                              aria-label="Section complete"
                            />
                          )}
                        </TabsTrigger>
                        {lockedByOther && isMaster && (
                          <button
                            type="button"
                            title={`Force-release ${lock.username}'s lock`}
                            onClick={() => forceReleaseLockMutation.mutate({ id: reportId, section })}
                            className="px-2 rounded-sm text-muted-foreground hover:text-status-critical hover:bg-status-critical/10 self-center shrink-0"
                          >
                            <LockOpen className="w-4 h-4" />
                            <span className="sr-only">Force-release lock on {section}</span>
                          </button>
                        )}
                      </Fragment>
                    );
                  })}
                </TabsList>
              </div>
            )}

            <CardContent className="pt-6 2xl:flex-1 2xl:min-h-0 2xl:overflow-y-auto">
              <form onSubmit={(e) => e.preventDefault()} noValidate>
                {sections.map(section => {
                  const sectionFields = schema.fields
                    .filter(f => f.section === section || (!f.section && section === sections[0]))
                    .map(f => ({
                      field: f,
                      state: effectiveState(
                        { ...f, section: f.section || section, relevance: f.relevance || '' } as SchemaField,
                        policy,
                        policyEvents,
                        report?.eventType,
                      ),
                    }))
                    .filter(({ state }) => state !== 'hidden')
                    // Minutes/hemisphere fields render as part of their
                    // degree field's own compound PositionField below,
                    // never as their own standalone field.
                    .filter(({ field }) => !POSITION_CONSUMED_FIELDS.has(field.name));
                  // "attachments" is a real schema section with no form
                  // fields of its own — the upload widget belongs here,
                  // not permanently visible below every other tab (it used
                  // to render unconditionally under the card, so it showed
                  // up regardless of which tab — including this one — was
                  // selected).
                  if (section === 'attachments' && sectionFields.length === 0) {
                    return (
                      <TabsContent key={section} value={section} className="space-y-6 mt-0">
                        <AttachmentsSection reportId={reportId} />
                      </TabsContent>
                    );
                  }
                  return (
                  <TabsContent key={section} value={section} className="space-y-6 mt-0">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-5">
                      {sectionFields.map(({ field, state }) => {
                        const positionGroup = POSITION_GROUPS[field.name];
                        if (positionGroup) {
                          return (
                            <div key={field.name} className="space-y-2 md:col-span-2">
                              <Label className="text-foreground flex flex-wrap items-center gap-x-2">
                                <span className="font-medium">{positionGroup.label}</span>
                                {(state === 'schemaMandatory' || state === 'companyMandatory') && (
                                  <span className="instrument-label text-status-critical">
                                    <span aria-hidden="true">*</span> Required
                                  </span>
                                )}
                              </Label>
                              <PositionField
                                axis={positionGroup.axis}
                                label={positionGroup.label}
                                control={control}
                                degreeName={field.name}
                                minutesName={positionGroup.minutes}
                                hemisphereName={positionGroup.hemisphere}
                                required={state === 'schemaMandatory' || state === 'companyMandatory'}
                              />
                            </div>
                          );
                        }
                        return (
                        <div key={field.name} className="space-y-2">
                          <Label htmlFor={field.name} className="text-foreground flex items-center">
                            {field.label || field.name}
                            {(state === 'schemaMandatory' || state === 'companyMandatory') && (
                              <span className="text-status-critical ml-1">*</span>
                            )}
                            {state === 'recommended' && (
                              <span className="ml-2 text-xs font-normal uppercase tracking-wide text-status-warn/80">Recommended</span>
                            )}
                          </Label>
                          {field.description && (
                            <p className="text-xs text-muted-foreground">{field.description}</p>
                          )}
                          {derived[field.name] && (
                            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                              <span className="inline-flex items-center gap-1"><Cpu className="w-3 h-3 shrink-0" aria-hidden="true" />Computed: {derived[field.name].formula}</span>
                              {overriddenFields.has(field.name) && (
                                <button
                                  type="button"
                                  onClick={() => handleRestoreComputed(field.name)}
                                  className="inline-flex items-center gap-1 text-muted-foreground hover:text-primary underline underline-offset-2"
                                >
                                  <RotateCcw className="w-3 h-3" /> Restore computed
                                </button>
                              )}
                            </div>
                          )}
                          <Controller
                            name={field.name}
                            control={control}
                            rules={{ required: state === 'schemaMandatory' || state === 'companyMandatory' }}
                            render={({ field: controllerField }) => {
                              if (field.type === 'enum') {
                                const enumValues = field.enumRef ? enumValuesByRef[field.enumRef] : undefined;
                                // No resolvable enumRef (or the registry has no
                                // file for it, e.g. "offshore-modes") — fall back
                                // to unrestricted text entry rather than an
                                // empty, unusable dropdown.
                                if (!enumValues || enumValues.length === 0) {
                                  return (
                                    <Input
                                      id={field.name}
                                      name={controllerField.name}
                                      onBlur={controllerField.onBlur}
                                      ref={controllerField.ref}
                                      value={controllerField.value ?? ''}
                                      onChange={(e) => controllerField.onChange(e.target.value)}
                                      type="text"
                                      className="bg-card"
                                    />
                                  );
                                }
                                // Log Abstract's "Event" field is chosen once, at
                                // creation (see reports/new/page.tsx's event picker),
                                // and locked from then on — mirrors the original's
                                // FieldRow.tsx LOCKED_FIELDS: "no way to ever set it
                                // afterward, start a new report to change it."
                                const isLockedEventField = isEventLockField(field) && !!report.eventType;
                                return (
                                  <Select
                                    onValueChange={controllerField.onChange}
                                    value={controllerField.value ?? ''}
                                    disabled={isLockedEventField}
                                  >
                                    <SelectTrigger id={field.name} className="bg-card disabled:opacity-100 disabled:bg-muted disabled:cursor-not-allowed">
                                      <SelectValue placeholder="Select an option" />
                                    </SelectTrigger>
                                    <SelectContent className="bg-popover">
                                      {enumValues.map((code) => (
                                        <SelectItem key={code} value={code}>{code}</SelectItem>
                                      ))}
                                    </SelectContent>
                                  </Select>
                                );
                              }

                              // A schema `date` field validated against a
                              // date-only format, but both types rendered as
                              // datetime-local — so the control emitted
                              // "2026-08-26T10:30" and every date field failed
                              // its own Health Check with "does not match the
                              // expected format", with no way to correct it
                              // from the UI.
                              if (field.type === 'date' || field.type === 'dateTime') {
                                return (
                                  <Input
                                    id={field.name}
                                      name={controllerField.name}
                                    onBlur={controllerField.onBlur}
                                    ref={controllerField.ref}
                                    value={field.type === 'dateTime' ? dateTimeForInput(String(controllerField.value ?? '')) : (controllerField.value ?? '')}
                                    onChange={(e) => controllerField.onChange(e.target.value)}
                                    type={field.type === 'date' ? 'date' : 'datetime-local'}
                                    className="bg-card"
                                  />
                                );
                              }

                              const isLiveComputed = liveComputedFields.includes(field.name);
                              return (
                                <Input
                                  id={field.name}
                                      name={controllerField.name}
                                  onBlur={controllerField.onBlur}
                                  ref={controllerField.ref}
                                  value={controllerField.value ?? ''}
                                  onChange={(e) => {
                                    if (isLiveComputed) {
                                      setOverriddenFields((prev) => (prev.has(field.name) ? prev : new Set(prev).add(field.name)));
                                    }
                                    controllerField.onChange(e.target.value);
                                  }}
                                  type={field.type === 'wholeNumber' || field.type === 'decimal' ? 'number' : 'text'}
                                  className="bg-card"
                                />
                              );
                            }}
                          />
                        </div>
                        );
                      })}
                    </div>
                  </TabsContent>
                  );
                })}
              </form>
            </CardContent>
          </Tabs>
        </Card>
      </div>

      {/* Health Check Panel */}
      <div className="w-full 2xl:w-80 2xl:h-full 2xl:min-h-0 shrink-0 flex flex-col">
        <Card className="bg-card border-border rounded-sm 2xl:flex-1 2xl:min-h-0 flex flex-col">
          <CardHeader className="border-b border-border pb-4 shrink-0">
            <CardTitle className="text-lg flex items-center">
              Health Check
            </CardTitle>
            <CardDescription>
              {checkResult ? 'Field rules, plausibility, and continuity against the committed chain' : 'Not yet checked'}
            </CardDescription>
          </CardHeader>
          <CardContent className="pt-4 2xl:flex-1 2xl:min-h-0 flex flex-col">
            <AnimatePresence mode="wait">
              {serverErrors.length > 0 && (
                <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="mb-3 space-y-2 shrink-0">
                  {serverErrors.map((err, idx) => (
                    <div key={idx} className="flex items-center text-status-critical bg-status-critical/10 p-3 rounded-sm border border-status-critical/25 text-xs">
                      <AlertCircle className="w-4 h-4 mr-2 shrink-0" />
                      {err}
                    </div>
                  ))}
                </motion.div>
              )}

              {!checkResult ? (
                <motion.div
                  key="unchecked"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="flex flex-col items-center justify-center py-6 text-center space-y-3"
                >
                  <div className="p-3 bg-muted rounded-full">
                    <CheckCircle2 className="w-6 h-6 text-muted-foreground" />
                  </div>
                  <div>
                    <h4 className="text-sm font-medium text-foreground">Not checked yet</h4>
                    <p className="text-xs text-muted-foreground mt-1">Run Health Check before submitting</p>
                  </div>
                </motion.div>
              ) : (
                <motion.div key="checked" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-3 2xl:flex-1 2xl:min-h-0 flex flex-col">
                  {(() => {
                    const errors = checkResult.findings.filter((f) => f.severity === 'error');
                    const warnings = checkResult.findings.filter((f) => f.severity === 'warning');
                    return (
                      <>
                        {errors.length === 0 ? (
                          <div className="flex items-center text-status-ok bg-status-ok/10 p-3 rounded-sm border border-status-ok/25 shrink-0">
                            <CheckCircle2 className="w-5 h-5 mr-2 shrink-0" />
                            <span className="text-sm font-medium">Ready for submission</span>
                          </div>
                        ) : (
                          <div className="flex items-center text-status-critical bg-status-critical/10 p-3 rounded-sm border border-status-critical/25 shrink-0">
                            <AlertCircle className="w-5 h-5 mr-2 shrink-0" />
                            <span className="text-sm font-medium">{errors.length} error{errors.length === 1 ? '' : 's'} must be fixed</span>
                          </div>
                        )}

                        {/* Regulatory readiness and continuity impact are
                            always visible, never pushed out of sight below
                            a long findings list — only the findings
                            themselves scroll internally. */}
                        {checkResult.regulatoryReadiness.length > 0 && (
                          <div className="shrink-0 space-y-1.5">
                            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Regulatory readiness</p>
                            {checkResult.regulatoryReadiness.map((p) => (
                              <div key={p.profile} className="flex items-center justify-between text-xs">
                                <span className="text-foreground">{p.profile.toUpperCase()}</span>
                                <span className={p.ready ? 'text-status-ok' : 'text-status-warn/80'}>
                                  {p.ready ? 'Ready' : `${p.missingFields.length} missing`}
                                </span>
                              </div>
                            ))}
                          </div>
                        )}
                        {checkResult.continuityImpact.length > 0 && (
                          <div className="shrink-0 space-y-1.5">
                            <p className="text-xs font-medium uppercase tracking-wide text-status-critical">Other reports invalidated</p>
                            {checkResult.continuityImpact.map((c) => (
                              <div key={c.reportId} className="text-xs text-muted-foreground">
                                {c.eventType} · {c.invalidatedRules.join(', ')}
                              </div>
                            ))}
                          </div>
                        )}

                        {warnings.length > 0 && (
                          <div className="text-xs text-status-warn/80 font-medium uppercase tracking-wide shrink-0 pt-1 border-t border-border">
                            {warnings.length} warning{warnings.length === 1 ? '' : 's'}
                          </div>
                        )}
                        <p className="instrument-label shrink-0 pt-1">
                          {errors.length + warnings.length} finding{errors.length + warnings.length === 1 ? '' : 's'}
                        </p>
                        <div className="space-y-2 max-h-[22rem] overflow-y-auto border-t border-border pt-2 2xl:max-h-none 2xl:border-t-0 2xl:pt-0 2xl:flex-1 2xl:min-h-0">
                          {[...errors, ...warnings].map((f, idx) => {
                            const ackKey = `${f.ruleId}:${f.field ?? ''}`;
                            const acknowledged = acknowledgedFindings.get(ackKey) ?? false;
                            return (
                              <div
                                key={`${f.ruleId}-${f.field ?? ''}-${idx}`}
                                className={`w-full text-xs p-2 rounded bg-card border transition-colors ${
                                  f.severity === 'error'
                                    ? 'border-status-critical/30 text-foreground'
                                    : acknowledged
                                      ? 'border-border text-muted-foreground/60'
                                      : 'border-border text-muted-foreground'
                                }`}
                              >
                                <button
                                  type="button"
                                  onClick={() => setActiveSection(sectionForField(f.field))}
                                  className={`w-full text-left hover:text-foreground ${acknowledged ? 'line-through' : ''}`}
                                >
                                  {f.message}
                                </button>
                                {f.severity === 'warning' && (
                                  <button
                                    type="button"
                                    onClick={() =>
                                      acknowledgeFindingMutation.mutate({
                                        id: reportId,
                                        ruleId: f.ruleId,
                                        field: f.field,
                                        message: f.message,
                                        acknowledged: !acknowledged,
                                      })
                                    }
                                    disabled={acknowledgeFindingMutation.isPending}
                                    className={`mt-1 text-[0.7rem] font-medium ${acknowledged ? 'text-status-ok hover:text-status-ok' : 'text-primary hover:text-primary/80'}`}
                                  >
                                    {acknowledged ? '✓ Acknowledged — undo' : 'Acknowledge'}
                                  </button>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </>
                    );
                  })()}
                </motion.div>
              )}
            </AnimatePresence>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
