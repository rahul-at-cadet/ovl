'use client';

import { useState, useEffect, useMemo } from 'react';
import { useForm, Controller, useWatch } from 'react-hook-form';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { AlertCircle, CheckCircle2, Save, Send, Loader2, Cpu } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { trpc } from '@/lib/trpc';
import { useRouter } from 'next/navigation';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { AttachmentsSection } from './AttachmentsSection';
import { useToastManager } from '@/components/ui/toast';

interface ReportFormProps {
  reportId: string;
}

export function ReportForm({ reportId }: ReportFormProps) {
  const router = useRouter();
  const toastManager = useToastManager();
  const [serverErrors, setServerErrors] = useState<string[]>([]);

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

  const submitReportMutation = trpc.reports.submitReport.useMutation();
  const saveSectionMutation = trpc.reports.saveSection.useMutation();
  const trpcUtils = trpc.useUtils();

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

  // Auto-save debounced effect
  useEffect(() => {
    if (!report || !schema || Object.keys(formValues).length === 0) return;

    const timer = setTimeout(() => {
      handleAction(formValues as Record<string, unknown>, 'draft', true);
    }, 1500);

    return () => clearTimeout(timer);
  }, [formValues, report, schema]);

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
        <Loader2 className="w-8 h-8 animate-spin text-blue-500 mb-4" />
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
        section: sections[0], // Only saving first section for MVP
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

  return (
    <div className="flex flex-col xl:flex-row gap-6 items-start animate-in fade-in slide-in-from-bottom-4 duration-500">
      {/* Form Area */}
      <div className="flex-1 w-full space-y-6">
        <div className="flex justify-between items-center bg-card/50 p-4 rounded-xl border border-border backdrop-blur-sm">
          <div>
            <h2 className="text-xl font-bold tracking-tight text-foreground">Drafting: {schema.schemaName}</h2>
          </div>
          <div className="flex gap-2">
            <Button type="button" onClick={() => handleAction(getValues(), 'draft')} variant="outline" className="border-border bg-background/50 text-foreground hover:text-white" disabled={saveSectionMutation.isPending || submitReportMutation.isPending}>
              <Save className="w-4 h-4 mr-2" />
              {saveSectionMutation.isPending ? 'Saving...' : 'Save Draft'}
            </Button>
            <Button type="button" onClick={handleSubmit((d) => handleAction(d, 'submit'))} className="bg-blue-600 hover:bg-blue-500 text-white shadow-lg shadow-blue-500/20" disabled={saveSectionMutation.isPending || submitReportMutation.isPending}>
              <Send className="w-4 h-4 mr-2" />
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
              className="text-xs bg-background border-border text-blue-400 hover:text-blue-300 hover:bg-muted"
              onClick={handlePrefillSensors}
              disabled={telemetryLoading || !telemetry}
            >
              <Cpu className="w-3 h-3 mr-2" />
              {telemetryLoading ? 'Reading Sensors...' : 'Pre-fill from Sensors'}
            </Button>
          </div>
          <Tabs defaultValue={sections[0]} className="w-full">
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
                {sections.map(section => (
                  <TabsContent key={section} value={section} className="space-y-6 mt-0">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                      {schema.fields.filter(f => f.section === section || (!f.section && section === sections[0])).map((field) => (
                        <div key={field.name} className="space-y-2">
                          <Label htmlFor={field.name} className="text-foreground flex items-center">
                            {field.label || field.name}
                            {field.schemaMandatory && <span className="text-red-400 ml-1">*</span>}
                          </Label>
                          {field.description && (
                            <p className="text-[10px] text-muted-foreground">{field.description}</p>
                          )}
                          <Controller
                            name={field.name}
                            control={control}
                            rules={{ required: field.schemaMandatory }}
                            render={({ field: controllerField }) => {
                              if (field.type === 'enum') {
                                return (
                                  <Select onValueChange={controllerField.onChange} value={controllerField.value}>
                                    <SelectTrigger className="bg-background/50 border-border text-foreground focus:ring-blue-500">
                                      <SelectValue placeholder="Select an option" />
                                    </SelectTrigger>
                                    <SelectContent className="bg-card border-border text-foreground">
                                      {/* Note: In a full implementation, enum options would come from the schema or a registry */}
                                      <SelectItem value="Option1">Option 1</SelectItem>
                                      <SelectItem value="Option2">Option 2</SelectItem>
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
                                    className="bg-background/50 border-border focus-visible:ring-blue-500 text-foreground"
                                  />
                                );
                              }

                              return (
                                <Input
                                  name={controllerField.name}
                                  onBlur={controllerField.onBlur}
                                  ref={controllerField.ref}
                                  value={controllerField.value ?? ''}
                                  onChange={(e) => controllerField.onChange(e.target.value)}
                                  type={field.type === 'wholeNumber' || field.type === 'decimal' ? 'number' : 'text'}
                                  className="bg-background/50 border-border focus-visible:ring-blue-500 text-foreground"
                                />
                              );
                            }}
                          />
                        </div>
                      ))}
                    </div>
                  </TabsContent>
                ))}
              </form>
            </CardContent>
          </Tabs>
        </Card>

        <AttachmentsSection reportId={reportId} />
        <Card className="bg-card/50 border-border mt-6">
          <CardHeader>
            <CardTitle className="text-sm text-muted-foreground">Debug: Form Values</CardTitle>
          </CardHeader>
          <CardContent>
            <pre className="text-xs text-foreground overflow-auto max-h-60">
              {JSON.stringify(formValues, null, 2)}
            </pre>
          </CardContent>
        </Card>
      </div>

      {/* Health Check Panel (Errors) */}
      <div className="w-full xl:w-80 shrink-0">
        <Card className="bg-card/50 border-border sticky top-24">
          <CardHeader className="border-b border-border pb-4">
            <CardTitle className="text-lg flex items-center">
              Health Check
            </CardTitle>
            <CardDescription>Live validation status</CardDescription>
          </CardHeader>
          <CardContent className="pt-4">
            <AnimatePresence mode="wait">
              {serverErrors.length > 0 ? (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  className="space-y-3"
                >
                  <div className="flex items-center text-red-400 bg-red-500/10 p-3 rounded-lg border border-red-500/20">
                    <AlertCircle className="w-5 h-5 mr-2 shrink-0" />
                    <span className="text-sm font-medium">{serverErrors.length} Issue(s) Found</span>
                  </div>
                  <div className="space-y-2">
                    {serverErrors.map((err, idx) => (
                      <div key={idx} className="text-xs text-muted-foreground p-2 rounded bg-background/50 border border-border/50 hover:border-red-500/30 cursor-pointer transition-colors">
                        {err}
                      </div>
                    ))}
                  </div>
                </motion.div>
              ) : (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="flex flex-col items-center justify-center py-6 text-center space-y-3"
                >
                  <div className="p-3 bg-green-500/10 rounded-full">
                    <CheckCircle2 className="w-6 h-6 text-green-400" />
                  </div>
                  <div>
                    <h4 className="text-sm font-medium text-foreground">All checks passed</h4>
                    <p className="text-xs text-muted-foreground mt-1">Ready for submission</p>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
