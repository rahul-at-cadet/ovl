'use client';

import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Plus, FileText, Loader2, AlertCircle } from 'lucide-react';
import { trpc } from '@/lib/trpc';

// Ports ovl/web/office/src/screens/commercial/{CommercialScreen,
// CommercialReportForm}.tsx — office-authored data (architecture 12.2,
// Commercial Editor role), the only two schemas ever entered here
// rather than synced up from a vessel. Same list anatomy as the
// Reports Ledger, scoped to just these two schemas, with a "New"
// create action instead of anything vessel-submitted.
const SCHEMA_BY_TAB = {
  periods: 'commercial-period',
  cargo: 'cargo-nomination',
} as const;
type Tab = keyof typeof SCHEMA_BY_TAB;

const TAB_LABEL: Record<Tab, string> = {
  periods: 'Commercial Periods',
  cargo: 'Cargo Nominations',
};

// A field this long (Description, Carbon_Offset_Reference/Comment, …) reads
// as free-form prose, not a short value — cramming it into the same
// single-line half-width slot as "Period start" left an awkward empty
// column beside it. Render it full-width as a multi-line textarea instead.
function isLongTextField(f: { type: string; maxLength?: number | null }): boolean {
  return f.type === 'text' && (f.maxLength ?? 0) >= 100;
}

function nativeInputType(type: string): string {
  switch (type) {
    case 'wholeNumber':
    case 'decimal':
      return 'number';
    case 'date':
      return 'date';
    case 'time':
      return 'time';
    case 'dateTime':
      return 'datetime-local';
    default:
      return 'text';
  }
}

function coerceFieldValue(type: string, raw: string | undefined): unknown {
  if (raw === undefined || raw.trim() === '') return null;
  if (type === 'wholeNumber' || type === 'decimal') {
    const n = Number(raw);
    return Number.isNaN(n) ? raw : n;
  }
  // Native <input type="datetime-local"> emits "yyyy-mm-ddThh:mm" —
  // pkg/validation's dateTimeLayout (OVD 3.13) expects a space instead
  // of "T", same reconciliation the original's own coerceFieldValue
  // does for exactly this field type.
  if (type === 'dateTime') return raw.replace('T', ' ');
  return raw;
}

export default function CommercialPage() {
  const [tab, setTab] = useState<Tab>('periods');
  const [isCreateOpen, setIsCreateOpen] = useState(false);

  const schemaName = SCHEMA_BY_TAB[tab];
  const utils = trpc.useUtils();
  const { data: reports = [], isLoading } = trpc.commercial.list.useQuery({ schemaName });
  const { data: vessels = [] } = trpc.vessels.list.useQuery();
  const { data: schemaFieldsResult } = trpc.schemas.getFields.useQuery({ schemaName }, { enabled: isCreateOpen });

  const [vesselId, setVesselId] = useState('');
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [findings, setFindings] = useState<{ field?: string; message: string }[]>([]);

  const createMutation = trpc.commercial.create.useMutation({
    onSuccess: (result) => {
      if (result.report) {
        setIsCreateOpen(false);
        setVesselId('');
        setFieldValues({});
        setFindings([]);
        utils.commercial.list.invalidate({ schemaName });
      } else {
        setFindings(result.findings);
      }
    },
  });

  const handleOpenCreate = (open: boolean) => {
    if (!open) {
      setVesselId('');
      setFieldValues({});
      setFindings([]);
      createMutation.reset();
    }
    setIsCreateOpen(open);
  };

  const selectVessel = (id: string) => {
    setVesselId(id);
    const v = vessels.find((vessel: any) => vessel.id === id);
    // Every curated commercial schema carries an IMO field — the
    // officer already named the vessel via the picker, so carry that
    // number forward instead of making them re-type it into a second,
    // easy-to-miss field (mirrors vessel/httpapi's own IMO
    // carryForward). Still a normal editable field afterward.
    if (v) setFieldValues((prev) => ({ ...prev, IMO: String(v.imo) }));
  };

  const handleSubmit = () => {
    const fields: Record<string, unknown> = {};
    for (const f of schemaFieldsResult?.fields ?? []) {
      const coerced = coerceFieldValue(f.type, fieldValues[f.name]);
      if (coerced !== null) fields[f.name] = coerced;
    }
    createMutation.mutate({ schemaName, vesselId, fields });
  };

  const findingByField = new Map((findings || []).map((f) => [f.field, f.message]));

  return (
    <div className="h-[calc(100vh-136px)] lg:h-[calc(100vh-168px)] flex flex-col space-y-6 overflow-hidden">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 shrink-0">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Commercial</h1>
          <p className="text-muted-foreground mt-1 text-sm">Office-authored cargo nominations and commercial periods.</p>
        </div>
        <Dialog open={isCreateOpen} onOpenChange={handleOpenCreate}>
          <Button onClick={() => setIsCreateOpen(true)} className="bg-primary hover:bg-primary/90 text-primary-foreground rounded-sm h-9 text-sm font-medium shadow-sm">
            <Plus className="w-4 h-4 mr-2" />
            New {tab === 'periods' ? 'Commercial Period' : 'Cargo Nomination'}
          </Button>
          <DialogContent className="sm:max-w-[600px] max-h-[80vh] overflow-y-auto bg-background border-border text-foreground">
            <DialogHeader>
              <DialogTitle>New {tab === 'periods' ? 'Commercial Period' : 'Cargo Nomination'}</DialogTitle>
              <DialogDescription className="text-muted-foreground">
                Submitted as one action — no draft is saved until it passes.
              </DialogDescription>
            </DialogHeader>

            {createMutation.error && (
              <div className="flex items-center gap-2 text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-md p-3">
                <AlertCircle className="w-4 h-4 shrink-0" />
                {createMutation.error.message}
              </div>
            )}
            {findings.length > 0 && (
              <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-md p-3">
                {findings.length} issue{findings.length === 1 ? '' : 's'} must be fixed before this can be submitted.
              </div>
            )}

            <div className="space-y-2">
              <Label className="text-foreground">Vessel</Label>
              <Select value={vesselId} onValueChange={(v) => v && selectVessel(v)}>
                <SelectTrigger className="bg-card border-border text-foreground">
                  <SelectValue placeholder="Select a vessel…" />
                </SelectTrigger>
                <SelectContent className="bg-card border-border text-foreground">
                  {vessels.map((v: any) => (
                    <SelectItem key={v.id} value={v.id}>{v.imo} — {v.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {!schemaFieldsResult ? (
              <p className="text-sm text-muted-foreground py-4">Loading form…</p>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {schemaFieldsResult.fields
                  .filter((f) => f.name !== 'IMO')
                  .map((f) => (
                    <div key={f.name} className={`space-y-1.5 ${isLongTextField(f) ? 'sm:col-span-2' : ''}`}>
                      <Label className="text-foreground text-sm flex items-center">
                        {f.label}
                        {f.schemaMandatory && <span className="text-red-400 ml-1">*</span>}
                      </Label>
                      {isLongTextField(f) ? (
                        <Textarea
                          value={fieldValues[f.name] ?? ''}
                          onChange={(e) => setFieldValues((prev) => ({ ...prev, [f.name]: e.target.value }))}
                          maxLength={f.maxLength ?? undefined}
                          className={`bg-background/50 border-border focus-visible:ring-primary text-foreground ${findingByField.has(f.name) ? 'border-red-500/50' : ''}`}
                        />
                      ) : (
                        <Input
                          type={nativeInputType(f.type)}
                          value={fieldValues[f.name] ?? ''}
                          onChange={(e) => setFieldValues((prev) => ({ ...prev, [f.name]: e.target.value }))}
                          className={`bg-background/50 border-border focus-visible:ring-primary text-foreground ${findingByField.has(f.name) ? 'border-red-500/50' : ''}`}
                        />
                      )}
                      {findingByField.has(f.name) && (
                        <p className="text-xs text-red-400">{findingByField.get(f.name)}</p>
                      )}
                    </div>
                  ))}
              </div>
            )}

            <DialogFooter>
              <Button variant="outline" onClick={() => handleOpenCreate(false)} className="border-border bg-background text-foreground hover:bg-muted">
                Cancel
              </Button>
              <Button
                onClick={handleSubmit}
                disabled={!vesselId || createMutation.isPending}
                className="bg-primary hover:bg-primary/90 text-primary-foreground"
              >
                {createMutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
                Submit
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <Card className="flex-1 flex flex-col bg-card/50 border-border shadow-xl min-h-0 overflow-hidden">
        <CardHeader className="pb-0 shrink-0">
          <Tabs value={tab} onValueChange={(v) => v && setTab(v as Tab)}>
            <TabsList className="bg-background/50 border border-border">
              <TabsTrigger value="periods" className="data-[state=active]:bg-muted data-[state=active]:text-foreground">
                {TAB_LABEL.periods}
              </TabsTrigger>
              <TabsTrigger value="cargo" className="data-[state=active]:bg-muted data-[state=active]:text-foreground">
                {TAB_LABEL.cargo}
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </CardHeader>
        <CardContent className="flex-1 min-h-0 p-0 overflow-hidden mt-4">
          <div className="h-full overflow-auto">
            <Table>
              <TableHeader className="bg-background/90 backdrop-blur-sm sticky top-0 z-10">
                <TableRow className="border-border hover:bg-transparent">
                  <TableHead className="text-muted-foreground font-medium">Vessel / IMO</TableHead>
                  <TableHead className="text-muted-foreground font-medium">Type</TableHead>
                  <TableHead className="text-muted-foreground font-medium">Status</TableHead>
                  <TableHead className="text-muted-foreground font-medium">Submitted</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow>
                    <TableCell colSpan={4} className="text-center py-12 text-muted-foreground">Loading…</TableCell>
                  </TableRow>
                ) : reports.length > 0 ? (
                  reports.map((r: any) => (
                    <TableRow key={r.id} className="border-border hover:bg-muted/30 transition-colors">
                      <TableCell>
                        <div className="flex flex-col">
                          <span className="font-semibold text-foreground">{r.vessel}</span>
                          <span className="text-xs text-muted-foreground">IMO {r.imo}</span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center text-foreground">
                          <FileText className="w-4 h-4 text-muted-foreground mr-2" />
                          {r.type}
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className="bg-emerald-500/10 text-emerald-400 border-emerald-500/20">
                          {r.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-muted-foreground">{new Date(r.date).toLocaleString()}</TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell colSpan={4} className="text-center py-12 text-muted-foreground">
                      No {TAB_LABEL[tab].toLowerCase()} yet.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
