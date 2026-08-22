'use client';

import { useState, useEffect, useMemo, useRef } from 'react';
import { useForm, Controller, useWatch } from 'react-hook-form';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { AlertCircle, CheckCircle2, Save, Send, Loader2, Cpu, RotateCcw } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { trpc } from '@/lib/trpc';
import { useRouter } from 'next/navigation';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { AttachmentsSection } from './AttachmentsSection';
import { useToastManager } from '@/components/ui/toast';
import { effectiveState, type SchemaField } from '@/lib/config/fieldPolicyLogic';
import { computeDerivedValues, computeTimeSincePreviousReport, DERIVED_FIELDS } from '@/lib/derivedFields';
import { PositionField } from './PositionField';

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

interface ReportFormProps {
  reportId: string;
}

export function ReportForm({ reportId }: ReportFormProps) {
  const router = useRouter();
  const toastManager = useToastManager();
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
  const saveSectionMutation = trpc.reports.saveSection.useMutation();
  const checkMutation = trpc.reports.check.useMutation();
  const trpcUtils = trpc.useUtils();

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
    if (JSON.stringify(formValues) !== checkedValuesRef.current) {
      setCheckResult(null);
      checkedValuesRef.current = null;
    }
  }, [formValues, checkResult]);

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

      Object.entries(updates).forEach(([key, value]) => {
        setValue(key, value, { shouldValidate: true, shouldDirty: true });
      });
    }
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
      <div className="flex flex-col items-center justify-center h-64 text-red-400">
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
      saveSectionMutation.mutate({
        id: reportId,
        section: activeSection ?? sections[0],
        changes: parsedFields
      }, {
        onSuccess: () => {
          if (!isAutoSave) {
            trpcUtils.reports.getReport.invalidate({ id: reportId });
          }
          trpcUtils.reports.listReports.invalidate();
        },
        onError: (err) => {
          if (!isAutoSave) {
            setServerErrors([err.message]);
          }
        }
      });
    }
  };

  const sections = schema.sections || ['General'];

  // Section a finding's field lives in, for click-to-jump — mirrors the
  // same fallback the form's own field rendering uses (section ||
  // sections[0]) so a finding always resolves to a real tab.
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
      else if (field.type === 'boolean') parsedFields[field.name] = val === 'true' || val === true;
      else parsedFields[field.name] = val;
    });

    try {
      await saveSectionMutation.mutateAsync({ id: reportId, section: activeSection ?? sections[0], changes: parsedFields });
      trpcUtils.reports.listReports.invalidate();
      const result = await checkMutation.mutateAsync({ id: reportId });
      checkedValuesRef.current = JSON.stringify(getValues());
      setCheckResult(result);
      trpcUtils.reports.getReport.invalidate({ id: reportId });
    } catch (err: any) {
      setServerErrors([err.message]);
    }
  };

  const canSubmit = report.state === 'ready';

  return (
    <div className="flex flex-col xl:flex-row gap-6 items-start animate-in fade-in slide-in-from-bottom-4 duration-500">
      {/* Form Area */}
      <div className="flex-1 w-full space-y-6">
        <div className="flex justify-between items-center bg-card/50 p-4 rounded-xl border border-border backdrop-blur-sm">
          <div>
            <h2 className="text-xl font-bold tracking-tight text-foreground">Drafting: {schema.schemaName}</h2>
          </div>
          <div className="flex gap-2">
            <Button type="button" onClick={() => handleAction(getValues(), 'draft')} variant="outline" className="border-border bg-background/50 text-foreground hover:text-foreground h-11 text-base px-5" disabled={saveSectionMutation.isPending || submitReportMutation.isPending}>
              <Save className="w-5 h-5 mr-2" />
              {saveSectionMutation.isPending ? 'Saving...' : 'Save Draft'}
            </Button>
            <Button type="button" onClick={handleRunCheck} variant="outline" className="border-border bg-background/50 text-foreground hover:text-foreground h-11 text-base px-5" disabled={checkMutation.isPending || submitReportMutation.isPending}>
              <CheckCircle2 className="w-5 h-5 mr-2" />
              {checkMutation.isPending ? 'Checking...' : 'Run Health Check'}
            </Button>
            <Button
              type="button"
              onClick={handleSubmit((d) => handleAction(d, 'submit'))}
              className="bg-primary hover:bg-primary/90 text-white shadow-lg shadow-primary/20 h-11 text-base px-5"
              disabled={saveSectionMutation.isPending || submitReportMutation.isPending || !canSubmit}
              title={canSubmit ? undefined : 'Run Health Check with zero errors before submitting'}
            >
              <Send className="w-5 h-5 mr-2" />
              {submitReportMutation.isPending ? 'Processing...' : 'Submit to Shore'}
            </Button>
          </div>
        </div>

        <Card className="bg-card/50 border-border">
          <div className="p-4 border-b border-border flex justify-between items-center">
            <h3 className="text-sm font-medium text-muted-foreground">Form Details</h3>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="text-xs bg-background border-border text-primary hover:text-primary hover:bg-muted"
              onClick={handlePrefillSensors}
              disabled={telemetryLoading || !telemetry}
            >
              <Cpu className="w-3 h-3 mr-2" />
              {telemetryLoading ? 'Reading Sensors...' : 'Pre-fill from Sensors'}
            </Button>
          </div>
          <Tabs value={activeSection ?? sections[0]} onValueChange={setActiveSection} className="w-full">
            {sections.length > 1 && (
              <CardHeader className="border-b border-border pb-0 pt-4 px-4">
                <TabsList className="bg-background/50 border border-border w-full justify-start h-auto p-1 overflow-x-auto">
                  {sections.map(section => (
                    <TabsTrigger key={section} value={section} className="data-[state=active]:bg-muted data-[state=active]:text-foreground px-6 py-2 capitalize">
                      {section.replace(/([A-Z])/g, ' $1').trim()}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </CardHeader>
            )}

            <CardContent className="pt-6">
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
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                      {sectionFields.map(({ field, state }) => {
                        const positionGroup = POSITION_GROUPS[field.name];
                        if (positionGroup) {
                          return (
                            <div key={field.name} className="space-y-2 md:col-span-2">
                              <Label className="text-foreground flex items-center">
                                {positionGroup.label}
                                {(state === 'schemaMandatory' || state === 'companyMandatory') && (
                                  <span className="text-red-400 ml-1">*</span>
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
                              <span className="text-red-400 ml-1">*</span>
                            )}
                            {state === 'recommended' && (
                              <span className="ml-2 text-xs font-normal uppercase tracking-wide text-amber-500/80">Recommended</span>
                            )}
                          </Label>
                          {field.description && (
                            <p className="text-xs text-muted-foreground">{field.description}</p>
                          )}
                          {derived[field.name] && (
                            <div className="flex items-center gap-2 text-xs text-primary/80">
                              <span>{derived[field.name].formula}</span>
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
                                      name={controllerField.name}
                                      onBlur={controllerField.onBlur}
                                      ref={controllerField.ref}
                                      value={controllerField.value ?? ''}
                                      onChange={(e) => controllerField.onChange(e.target.value)}
                                      type="text"
                                      className="bg-background/50 border-border focus-visible:ring-primary text-foreground"
                                    />
                                  );
                                }
                                // Log Abstract's "Event" field is chosen once, at
                                // creation (see reports/new/page.tsx's event picker),
                                // and locked from then on — mirrors the original's
                                // FieldRow.tsx LOCKED_FIELDS: "no way to ever set it
                                // afterward, start a new report to change it."
                                const isLockedEventField = field.name === 'Event' && field.enumRef === 'event-types' && !!report.eventType;
                                return (
                                  <Select
                                    onValueChange={controllerField.onChange}
                                    value={controllerField.value ?? ''}
                                    disabled={isLockedEventField}
                                  >
                                    <SelectTrigger className="bg-background/50 border-border text-foreground focus:ring-primary disabled:opacity-70 disabled:cursor-not-allowed">
                                      <SelectValue placeholder="Select an option" />
                                    </SelectTrigger>
                                    <SelectContent className="bg-card border-border text-foreground">
                                      {enumValues.map((code) => (
                                        <SelectItem key={code} value={code}>{code}</SelectItem>
                                      ))}
                                    </SelectContent>
                                  </Select>
                                );
                              }

                              if (field.type === 'date' || field.type === 'dateTime') {
                                return (
                                  <Input
                                    name={controllerField.name}
                                    onBlur={controllerField.onBlur}
                                    ref={controllerField.ref}
                                    value={controllerField.value ?? ''}
                                    onChange={(e) => controllerField.onChange(e.target.value)}
                                    type="datetime-local"
                                    className="bg-background/50 border-border focus-visible:ring-primary text-foreground"
                                  />
                                );
                              }

                              const isLiveComputed = liveComputedFields.includes(field.name);
                              return (
                                <Input
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
                                  className="bg-background/50 border-border focus-visible:ring-primary text-foreground"
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
      <div className="w-full xl:w-80 shrink-0">
        <Card className="bg-card/50 border-border sticky top-24">
          <CardHeader className="border-b border-border pb-4">
            <CardTitle className="text-lg flex items-center">
              Health Check
            </CardTitle>
            <CardDescription>
              {checkResult ? 'Field rules, plausibility, and continuity against the committed chain' : 'Not yet checked'}
            </CardDescription>
          </CardHeader>
          <CardContent className="pt-4">
            <AnimatePresence mode="wait">
              {serverErrors.length > 0 && (
                <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="mb-3 space-y-2">
                  {serverErrors.map((err, idx) => (
                    <div key={idx} className="flex items-center text-red-400 bg-red-500/10 p-3 rounded-lg border border-red-500/20 text-xs">
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
                <motion.div key="checked" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="space-y-3">
                  {(() => {
                    const errors = checkResult.findings.filter((f) => f.severity === 'error');
                    const warnings = checkResult.findings.filter((f) => f.severity === 'warning');
                    return (
                      <>
                        {errors.length === 0 ? (
                          <div className="flex items-center text-emerald-400 bg-emerald-500/10 p-3 rounded-lg border border-emerald-500/20">
                            <CheckCircle2 className="w-5 h-5 mr-2 shrink-0" />
                            <span className="text-sm font-medium">Ready for submission</span>
                          </div>
                        ) : (
                          <div className="flex items-center text-red-400 bg-red-500/10 p-3 rounded-lg border border-red-500/20">
                            <AlertCircle className="w-5 h-5 mr-2 shrink-0" />
                            <span className="text-sm font-medium">{errors.length} error{errors.length === 1 ? '' : 's'} must be fixed</span>
                          </div>
                        )}
                        {warnings.length > 0 && (
                          <div className="text-xs text-amber-500/80 font-medium uppercase tracking-wide">
                            {warnings.length} warning{warnings.length === 1 ? '' : 's'}
                          </div>
                        )}
                        <div className="space-y-2 max-h-[420px] overflow-y-auto">
                          {[...errors, ...warnings].map((f, idx) => (
                            <button
                              key={`${f.ruleId}-${f.field ?? ''}-${idx}`}
                              type="button"
                              onClick={() => setActiveSection(sectionForField(f.field))}
                              className={`w-full text-left text-xs p-2 rounded bg-background/50 border transition-colors ${
                                f.severity === 'error'
                                  ? 'border-red-500/30 text-foreground hover:border-red-500/50'
                                  : 'border-border/50 text-muted-foreground hover:border-amber-500/30 hover:text-foreground'
                              }`}
                            >
                              {f.message}
                            </button>
                          ))}
                        </div>
                        {checkResult.regulatoryReadiness.length > 0 && (
                          <div className="pt-2 border-t border-border/50 space-y-1.5">
                            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Regulatory readiness</p>
                            {checkResult.regulatoryReadiness.map((p) => (
                              <div key={p.profile} className="flex items-center justify-between text-xs">
                                <span className="text-foreground">{p.profile.toUpperCase()}</span>
                                <span className={p.ready ? 'text-emerald-400' : 'text-amber-500/80'}>
                                  {p.ready ? 'Ready' : `${p.missingFields.length} missing`}
                                </span>
                              </div>
                            ))}
                          </div>
                        )}
                        {checkResult.continuityImpact.length > 0 && (
                          <div className="pt-2 border-t border-border/50 space-y-1.5">
                            <p className="text-xs font-medium uppercase tracking-wide text-red-400">Other reports invalidated</p>
                            {checkResult.continuityImpact.map((c) => (
                              <div key={c.reportId} className="text-xs text-muted-foreground">
                                {c.eventType} · {c.invalidatedRules.join(', ')}
                              </div>
                            ))}
                          </div>
                        )}
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
