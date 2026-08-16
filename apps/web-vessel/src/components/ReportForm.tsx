'use client';

import { useState, useEffect } from 'react';
import { useForm, Controller } from 'react-hook-form';
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

interface ReportFormProps {
  schemaName: string;
}

export function ReportForm({ schemaName }: ReportFormProps) {
  const router = useRouter();
  const [serverErrors, setServerErrors] = useState<string[]>([]);
  
  // 1. Fetch Dynamic Schema
  const { data: schema, isLoading: isSchemaLoading, error: schemaError } = trpc.reports.getSchema.useQuery({
    schemaName
  });

  const { data: telemetry, isLoading: telemetryLoading } = trpc.system.getTelemetry.useQuery(undefined, {
    enabled: !!schema,
  });
  
  const submitReportMutation = trpc.reports.submitReport.useMutation();
  const createReportMutation = trpc.reports.createReport.useMutation();

  const { control, handleSubmit, reset, setValue } = useForm();

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

  // Reset form when schema changes to inject default values if needed
  useEffect(() => {
    if (schema) {
      const defaultValues: Record<string, string | number | boolean> = {};
      schema.fields.forEach(f => {
        defaultValues[f.name] = '';
      });
      reset(defaultValues);
    }
  }, [schema, reset]);

  if (isSchemaLoading) {
    return (
      <div className="flex flex-col items-center justify-center h-64 text-zinc-500">
        <Loader2 className="w-8 h-8 animate-spin text-blue-500 mb-4" />
        <p>Loading schema definition...</p>
      </div>
    );
  }

  if (schemaError || !schema) {
    return (
      <div className="flex flex-col items-center justify-center h-64 text-red-400">
        <AlertCircle className="w-8 h-8 mb-4" />
        <p>Failed to load schema: {schemaError?.message}</p>
      </div>
    );
  }

  const handleAction = (data: Record<string, unknown>, action: 'draft' | 'submit') => {
    setServerErrors([]);
    
    // Convert numeric fields based on schema definition
    const parsedFields: Record<string, unknown> = {};
    schema.fields.forEach(field => {
      const val = data[field.name];
      if (val === undefined || val === '') return;
      
      if (field.type === 'wholeNumber' || field.type === 'decimal') {
        parsedFields[field.name] = Number(val);
      } else if (field.type === 'boolean') {
        parsedFields[field.name] = val === 'true' || val === true;
      } else {
        parsedFields[field.name] = val;
      }
    });

    createReportMutation.mutate({
      schemaName,
      eventType: schemaName.replace('.json', ''),
      eventTime: new Date().toISOString(),
      fields: parsedFields
    }, {
      onSuccess: (res) => {
        if (action === 'submit') {
          submitReportMutation.mutate({ id: res.reportId }, {
            onSuccess: () => {
              alert('Report Submitted to Shore!');
              router.push(`/reports/${res.reportId}`);
            },
            onError: (err) => setServerErrors([err.message])
          });
        } else {
          alert('Draft Saved!');
          router.push(`/reports/${res.reportId}`);
        }
      },
      onError: (err) => setServerErrors([err.message])
    });
  };

  const sections = schema.sections || ['General'];

  return (
    <div className="flex flex-col xl:flex-row gap-6 items-start animate-in fade-in slide-in-from-bottom-4 duration-500">
      {/* Form Area */}
      <div className="flex-1 w-full space-y-6">
        <div className="flex justify-between items-center bg-zinc-900/50 p-4 rounded-xl border border-zinc-800 backdrop-blur-sm">
          <div>
            <h2 className="text-xl font-bold tracking-tight text-zinc-100">Drafting: {schema.schemaName}</h2>
            <p className="text-zinc-400 text-sm">Dynamic Form Renderer</p>
          </div>
          <div className="flex gap-2">
            <Button type="button" onClick={handleSubmit((d) => handleAction(d, 'draft'))} variant="outline" className="border-zinc-700 bg-zinc-950/50 text-zinc-300 hover:text-white" disabled={createReportMutation.isPending || submitReportMutation.isPending}>
              <Save className="w-4 h-4 mr-2" />
              Save Draft
            </Button>
            <Button type="button" onClick={handleSubmit((d) => handleAction(d, 'submit'))} className="bg-blue-600 hover:bg-blue-500 text-white shadow-lg shadow-blue-500/20" disabled={createReportMutation.isPending || submitReportMutation.isPending}>
              <Send className="w-4 h-4 mr-2" />
              {(createReportMutation.isPending || submitReportMutation.isPending) ? 'Processing...' : 'Submit to Shore'}
            </Button>
          </div>
        </div>

        <Card className="bg-zinc-900/50 border-zinc-800">
          <div className="p-4 border-b border-zinc-800 flex justify-between items-center">
            <h3 className="text-sm font-medium text-zinc-400">Form Details</h3>
            <Button 
              type="button" 
              variant="outline" 
              size="sm" 
              className="text-xs bg-zinc-950 border-zinc-800 text-blue-400 hover:text-blue-300 hover:bg-zinc-800"
              onClick={handlePrefillSensors}
              disabled={telemetryLoading || !telemetry}
            >
              <Cpu className="w-3 h-3 mr-2" />
              {telemetryLoading ? 'Reading Sensors...' : 'Pre-fill from Sensors'}
            </Button>
          </div>
          <Tabs defaultValue={sections[0]} className="w-full">
            {sections.length > 1 && (
              <CardHeader className="border-b border-zinc-800 pb-0 pt-4 px-4">
                <TabsList className="bg-zinc-950/50 border border-zinc-800 w-full justify-start h-auto p-1 overflow-x-auto">
                  {sections.map(section => (
                    <TabsTrigger key={section} value={section} className="data-[state=active]:bg-zinc-800 data-[state=active]:text-zinc-100 px-6 py-2 capitalize">
                      {section.replace(/([A-Z])/g, ' $1').trim()}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </CardHeader>
            )}

            <CardContent className="pt-6">
              <form onSubmit={(e) => e.preventDefault()}>
                {sections.map(section => (
                  <TabsContent key={section} value={section} className="space-y-6 mt-0">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                      {schema.fields.filter(f => f.section === section || (!f.section && section === sections[0])).map((field) => (
                        <div key={field.name} className="space-y-2">
                          <Label htmlFor={field.name} className="text-zinc-300 flex items-center">
                            {field.label || field.name}
                            {field.schemaMandatory && <span className="text-red-400 ml-1">*</span>}
                          </Label>
                          {field.description && (
                            <p className="text-[10px] text-zinc-500">{field.description}</p>
                          )}
                          <Controller
                            name={field.name}
                            control={control}
                            rules={{ required: field.schemaMandatory }}
                            render={({ field: controllerField }) => {
                              if (field.type === 'enum') {
                                return (
                                  <Select onValueChange={controllerField.onChange} defaultValue={controllerField.value}>
                                    <SelectTrigger className="bg-zinc-950/50 border-zinc-800 text-zinc-100 focus:ring-blue-500">
                                      <SelectValue placeholder="Select an option" />
                                    </SelectTrigger>
                                    <SelectContent className="bg-zinc-900 border-zinc-800 text-zinc-100">
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
                                    {...controllerField}
                                    type="datetime-local"
                                    className="bg-zinc-950/50 border-zinc-800 focus-visible:ring-blue-500 text-zinc-100"
                                  />
                                );
                              }

                              return (
                                <Input 
                                  {...controllerField}
                                  type={field.type === 'wholeNumber' || field.type === 'decimal' ? 'number' : 'text'}
                                  className="bg-zinc-950/50 border-zinc-800 focus-visible:ring-blue-500 text-zinc-100"
                                />
                              );
                            }}
                          />
                        </div>
                      ))}
                    </div>
                  </TabsContent>
                ))}

                {/* Attachments UI */}
                <div className="mt-8 pt-6 border-t border-zinc-800">
                  <h3 className="text-lg font-medium text-zinc-100 mb-4">Attachments</h3>
                  <div className="space-y-4">
                    <Label className="text-zinc-300">Upload supporting documents (PDF, JPG, PNG)</Label>
                    <div className="flex items-center justify-center w-full">
                      <label htmlFor="dropzone-file" className="flex flex-col items-center justify-center w-full h-32 border-2 border-zinc-800 border-dashed rounded-lg cursor-pointer bg-zinc-950/50 hover:bg-zinc-900/50 transition-colors">
                        <div className="flex flex-col items-center justify-center pt-5 pb-6">
                          <svg className="w-8 h-8 mb-4 text-zinc-500" aria-hidden="true" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 20 16">
                            <path stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 13h3a3 3 0 0 0 0-6h-.025A5.56 5.56 0 0 0 16 6.5 5.5 5.5 0 0 0 5.207 5.021C5.137 5.017 5.071 5 5 5a4 4 0 0 0 0 8h2.167M10 15V6m0 0L8 8m2-2 2 2"/>
                          </svg>
                          <p className="mb-2 text-sm text-zinc-400"><span className="font-semibold text-blue-400">Click to upload</span> or drag and drop</p>
                          <p className="text-xs text-zinc-500">MAX 50MB per file</p>
                        </div>
                        <input id="dropzone-file" type="file" className="hidden" multiple />
                      </label>
                    </div>
                  </div>
                </div>
              </form>
            </CardContent>
          </Tabs>
        </Card>
      </div>

      {/* Health Check Panel (Errors) */}
      <div className="w-full xl:w-80 shrink-0">
        <Card className="bg-zinc-900/50 border-zinc-800 sticky top-24">
          <CardHeader className="border-b border-zinc-800 pb-4">
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
                      <div key={idx} className="text-xs text-zinc-400 p-2 rounded bg-zinc-950/50 border border-zinc-800/50 hover:border-red-500/30 cursor-pointer transition-colors">
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
                    <h4 className="text-sm font-medium text-zinc-200">All checks passed</h4>
                    <p className="text-xs text-zinc-500 mt-1">Ready for submission</p>
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
