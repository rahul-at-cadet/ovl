"use client";

import { useMemo, useRef, useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@ovl/ui/components/tabs";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@ovl/ui/components/card";
import { Button } from "@ovl/ui/components/button";
import { Input } from "@ovl/ui/components/input";
import { Label } from "@ovl/ui/components/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@ovl/ui/components/table";
import { Badge } from "@ovl/ui/components/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@ovl/ui/components/dialog";
import { Upload, Plus, FileJson, Layers, Link as LinkIcon, ShieldAlert, ScrollText, Ship, Library, ShieldCheck } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { FormCatalogueTab } from "./FormCatalogueTab";
import { MasterCatalogueTab } from "./MasterCatalogueTab";
import { FieldPolicyTab } from "./FieldPolicyTab";
import { ComplianceTab } from "./ComplianceTab";
import { VesselConfigsTab } from "./VesselConfigsTab";
import { ScopeSelector } from "./ScopeSelector";
import { scopeLabel, type Scope } from "@/lib/config/complianceLogic";

export default function ConfigurationPage() {
  const [activeTab, setActiveTab] = useState("schemas");

  // Which catalogue tabs to offer. The server answers this rather than the
  // client inferring it from a role string, because "super admin" is a
  // platform-level fact recorded outside any tenant — and the server enforces
  // it regardless of what the UI chooses to render.
  const { data: access } = trpc.catalogue.whoami.useQuery();
  const catalogueEnabled = access?.enabled === true;
  const isSuperAdmin = access?.isSuperAdmin === true;

  return (
    <div className="p-8">
      <div className="flex justify-between items-center mb-8">
        <div>
          <h1 className="text-2xl font-heading font-semibold text-foreground">Fleet Configuration</h1>
          <p className="text-muted-foreground mt-2">Manage dynamic schemas and push config bundles to edge nodes.</p>
        </div>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab} orientation="horizontal" className="w-full">
        {/*
          Scrolls within itself rather than widening the page. With enough tabs
          the list outgrows the content column, and a page that scrolls
          sideways shifts every table under it — which reads as the headers and
          their rows drifting out of alignment, even though the table is fine.
        */}
        <TabsList className="mb-6 max-w-full overflow-x-auto justify-start">
          <TabsTrigger value="schemas" className="flex items-center gap-2">
            <FileJson className="w-4 h-4" />
            Schemas
          </TabsTrigger>
          {catalogueEnabled && (
            <TabsTrigger value="formCatalogue" className="flex items-center gap-2">
              <Library className="w-4 h-4" />
              Form Catalogue
            </TabsTrigger>
          )}
          {catalogueEnabled && isSuperAdmin && (
            <TabsTrigger value="masterCatalogue" className="flex items-center gap-2">
              <ShieldCheck className="w-4 h-4" />
              Platform Catalogue
            </TabsTrigger>
          )}
          <TabsTrigger value="fieldPolicy" className="flex items-center gap-2">
            <ShieldAlert className="w-4 h-4" />
            Field Policy
          </TabsTrigger>
          <TabsTrigger value="compliance" className="flex items-center gap-2">
            <ScrollText className="w-4 h-4" />
            Compliance
          </TabsTrigger>
          <TabsTrigger value="bundles" className="flex items-center gap-2">
            <Layers className="w-4 h-4" />
            Config Bundles
          </TabsTrigger>
          <TabsTrigger value="assignments" className="flex items-center gap-2">
            <LinkIcon className="w-4 h-4" />
            Assignments
          </TabsTrigger>
          <TabsTrigger value="vesselConfigs" className="flex items-center gap-2">
            <Ship className="w-4 h-4" />
            Vessel Configs
          </TabsTrigger>
        </TabsList>

        <TabsContent value="schemas">
          <SchemasTab />
        </TabsContent>

        {catalogueEnabled && (
          <TabsContent value="formCatalogue">
            <FormCatalogueTab />
          </TabsContent>
        )}

        {catalogueEnabled && isSuperAdmin && (
          <TabsContent value="masterCatalogue">
            <MasterCatalogueTab />
          </TabsContent>
        )}

        <TabsContent value="fieldPolicy">
          <FieldPolicyTab />
        </TabsContent>

        <TabsContent value="compliance">
          <ComplianceTab />
        </TabsContent>

        <TabsContent value="bundles">
          <BundlesTab />
        </TabsContent>

        <TabsContent value="assignments">
          <AssignmentsTab />
        </TabsContent>

        <TabsContent value="vesselConfigs">
          <VesselConfigsTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function SchemasTab() {
  const { data: schemas, isLoading, refetch } = trpc.schemas.list.useQuery();
  const publishSchema = trpc.schemas.publish.useMutation({
    onSuccess: () => refetch(),
  });
  const previewSchema = trpc.schemas.preview.useMutation();

  const [schemaName, setSchemaName] = useState("");
  const [showNameSuggestions, setShowNameSuggestions] = useState(false);
  const [version, setVersion] = useState("");
  const [content, setContent] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{
    forSchemaName: string;
    forContent: string;
    valid: boolean;
    error?: string;
    diff?: {
      added: { name: string }[];
      removed: { name: string }[];
      typeChanged: string[];
      mandatorinessChanged: string[];
      enumChanged: string[];
    } | null;
  } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const knownSchemaNames = useMemo(
    () => [...new Set((schemas ?? []).map((s) => s.schemaName))],
    [schemas],
  );

  const nameSuggestions = useMemo(() => {
    const q = schemaName.trim().toLowerCase();
    const matches = q
      ? knownSchemaNames.filter((n) => n.toLowerCase().includes(q) && n.toLowerCase() !== q)
      : knownSchemaNames;
    return matches.slice(0, 8);
  }, [knownSchemaNames, schemaName]);

  const invalidatePreview = () => setPreview(null);

  const handleFilePick = () => fileInputRef.current?.click();

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const text = await file.text();
    setContent(text);
    invalidatePreview();
    setError(null);
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed.schemaName === "string" && !schemaName) setSchemaName(parsed.schemaName);
      if (typeof parsed.version === "string" && !version) setVersion(parsed.version);
    } catch {
      // Leave name/version alone; the preview step will surface the parse error.
    }
  };

  const handleValidate = async () => {
    setError(null);
    if (!schemaName || !content) {
      setError("Schema name and JSON content are required to validate.");
      return;
    }
    const result = await previewSchema.mutateAsync({ schemaName, content });
    setPreview({ forSchemaName: schemaName, forContent: content, ...result });
  };

  const previewIsCurrent =
    preview && preview.forSchemaName === schemaName && preview.forContent === content;

  const handleUpload = async () => {
    setError(null);
    if (!schemaName || !version || !content) {
      setError("Please fill in all fields");
      return;
    }
    if (!previewIsCurrent || !preview?.valid) {
      setError("Validate the schema before publishing.");
      return;
    }

    try {
      await publishSchema.mutateAsync({
        schemaName,
        version,
        source: "companyEdited",
        content,
      });
      setSchemaName("");
      setVersion("");
      setContent("");
      setPreview(null);
    } catch (err: any) {
      setError(err.message || "Failed to publish schema");
    }
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <div className="lg:col-span-2 space-y-6">
        <Card className="bg-card border-border">
          <CardHeader>
            <CardTitle className="text-foreground">Published Schemas</CardTitle>
            <CardDescription>Immutable versions of data models available for config bundles.</CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <p className="text-muted-foreground">Loading schemas...</p>
            ) : schemas?.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground border border-dashed border-border rounded-md">
                <FileJson className="w-8 h-8 mx-auto mb-3 opacity-50" />
                <p>No schemas published yet</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="border-border hover:bg-transparent">
                      <TableHead>Schema Name</TableHead>
                      <TableHead>Version</TableHead>
                      <TableHead>Source</TableHead>
                      <TableHead>Published</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {schemas?.map((s) => (
                      <TableRow key={s.id} className="border-border hover:bg-muted/50">
                        <TableCell className="font-medium text-foreground">{s.schemaName}</TableCell>
                        <TableCell><span className="bg-status-info/30 text-status-info px-2 py-0.5 rounded text-xs font-mono">{s.version}</span></TableCell>
                        <TableCell className="text-muted-foreground capitalize">{s.source}</TableCell>
                        <TableCell className="text-muted-foreground">{new Date(s.publishedAt).toLocaleDateString()}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <div>
        <Card className="bg-card border-border">
          <CardHeader>
            <CardTitle className="text-foreground">Upload New Version</CardTitle>
            <CardDescription>Validate before publishing — published versions are immutable.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2 relative">
              <Label>Schema Name</Label>
              <Input
                placeholder="e.g. log-abstract"
                value={schemaName}
                onChange={e => { setSchemaName(e.target.value); invalidatePreview(); setShowNameSuggestions(true); }}
                onFocus={() => setShowNameSuggestions(true)}
                onBlur={() => setTimeout(() => setShowNameSuggestions(false), 150)}
                autoComplete="off"
                className="bg-background border-border text-foreground"
              />
              {showNameSuggestions && nameSuggestions.length > 0 && (
                <div className="absolute z-20 top-full mt-1 w-full rounded-md border border-border bg-popover text-popover-foreground shadow-md py-1 max-h-48 overflow-auto">
                  {nameSuggestions.map((n) => (
                    <button
                      key={n}
                      type="button"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => { setSchemaName(n); invalidatePreview(); setShowNameSuggestions(false); }}
                      className="w-full text-left px-3 py-1.5 text-sm hover:bg-muted"
                    >
                      {n}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="space-y-2">
              <Label>Version Tag</Label>
              <Input
                placeholder="e.g. 3.13-company-r2"
                value={version}
                onChange={e => setVersion(e.target.value)}
                className="bg-background border-border text-foreground"
              />
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>JSON Content</Label>
                <button
                  type="button"
                  onClick={handleFilePick}
                  className="text-xs text-status-info hover:text-status-info flex items-center gap-1"
                >
                  <FileJson className="w-3 h-3" />
                  Upload .json file
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="application/json,.json"
                  className="hidden"
                  onChange={handleFileChange}
                />
              </div>
              <textarea
                placeholder="Paste JSON or upload a .json file above"
                rows={10}
                value={content}
                onChange={e => { setContent(e.target.value); invalidatePreview(); }}
                className="w-full bg-background border border-border text-foreground font-mono text-xs rounded-md p-3 focus:outline-none focus:ring-2 focus:ring-status-info focus:border-transparent"
              />
            </div>

            {error && <p className="text-status-critical text-sm">{error}</p>}

            {previewIsCurrent && (
              preview!.valid ? (
                <div className="rounded-md border border-status-ok/30 bg-status-ok/10 p-3 space-y-2">
                  <p className="text-sm text-status-ok font-medium">Valid schema</p>
                  {preview!.diff ? (
                    <div className="flex flex-wrap gap-1.5">
                      {preview!.diff.added.length > 0 && (
                        <Badge variant="outline" className="border-status-ok/25 text-status-ok">+{preview!.diff.added.length} added</Badge>
                      )}
                      {preview!.diff.removed.length > 0 && (
                        <Badge variant="outline" className="border-status-critical/25 text-status-critical">-{preview!.diff.removed.length} removed</Badge>
                      )}
                      {preview!.diff.typeChanged.length > 0 && (
                        <Badge variant="outline" className="border-status-warn/25 text-status-warn">{preview!.diff.typeChanged.length} type changed</Badge>
                      )}
                      {preview!.diff.mandatorinessChanged.length > 0 && (
                        <Badge variant="outline" className="border-status-warn/25 text-status-warn">{preview!.diff.mandatorinessChanged.length} mandatoriness changed</Badge>
                      )}
                      {preview!.diff.enumChanged.length > 0 && (
                        <Badge variant="outline" className="border-status-warn/25 text-status-warn">{preview!.diff.enumChanged.length} enum changed</Badge>
                      )}
                      {preview!.diff.added.length === 0 &&
                        preview!.diff.removed.length === 0 &&
                        preview!.diff.typeChanged.length === 0 &&
                        preview!.diff.mandatorinessChanged.length === 0 &&
                        preview!.diff.enumChanged.length === 0 && (
                          <span className="text-xs text-muted-foreground">No field changes from the current version.</span>
                        )}
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground">First published version of this schema.</p>
                  )}
                </div>
              ) : (
                <div className="rounded-md border border-status-critical/30 bg-status-critical/10 p-3">
                  <p className="text-sm text-status-critical">{preview!.error}</p>
                </div>
              )
            )}

            <div className="flex gap-2">
              <Button
                onClick={handleValidate}
                disabled={previewSchema.isPending || !schemaName || !content}
                variant="outline"
                className="flex-1 border-border"
              >
                {previewSchema.isPending ? "Validating..." : "Validate"}
              </Button>
              <Button
                onClick={handleUpload}
                disabled={publishSchema.isPending || !previewIsCurrent || !preview?.valid}
                className="flex-1"
              >
                <Upload className="w-4 h-4 mr-2" />
                {publishSchema.isPending ? "Publishing..." : "Publish"}
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function BundlesTab() {
  const { data: bundles, isLoading, refetch } = trpc.configBundles.list.useQuery();
  const { data: preview } = trpc.configBundles.preview.useQuery();
  const { data: assignments } = trpc.configBundles.listAssignments.useQuery();
  const { data: vessels = [] } = trpc.vessels.list.useQuery();
  const { data: vesselConfigs } = trpc.configBundles.vesselConfigs.useQuery();
  const publishBundle = trpc.configBundles.publish.useMutation({
    onSuccess: () => refetch(),
  });

  const [label, setLabel] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);

  const assignedToByBundle = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const a of assignments ?? []) {
      const list = map.get(a.bundleId) ?? [];
      list.push(scopeLabel(a.scope as Scope, vessels as any));
      map.set(a.bundleId, list);
    }
    return map;
  }, [assignments, vessels]);

  // Real per-bundle rollout state. This row used to render a hardcoded
  // "Pending next sync" for every assigned bundle, so it never changed no
  // matter how many times a vessel synced — and a vessel that could not
  // sync at all looked exactly like one that had.
  const rolloutByBundle = useMemo(() => {
    const map = new Map<string, { applied: number; total: number }>();
    for (const row of vesselConfigs ?? []) {
      if (!row.assignedBundleId) continue;
      const tally = map.get(row.assignedBundleId) ?? { applied: 0, total: 0 };
      tally.total += 1;
      if (row.status === "synced") tally.applied += 1;
      map.set(row.assignedBundleId, tally);
    }
    return map;
  }, [vesselConfigs]);

  const handlePublish = async () => {
    await publishBundle.mutateAsync({ label: label || "New Config Bundle" });
    setLabel("");
    setConfirmOpen(false);
  };

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h2 className="text-xl font-heading font-medium text-foreground">Config Bundles</h2>
      </div>

      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-foreground text-base">Compose New Bundle</CardTitle>
          <CardDescription>
            Captures a snapshot of every published schema&apos;s latest version, field policy, regulatory
            profile, cadence, and rule-severity setting right now. Publishing does not change what&apos;s
            assigned to any vessel or group until you assign it below.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {preview && (
            <div className="flex flex-wrap gap-2">
              <Badge variant="secondary">{preview.counts.schemaVersions} schemas</Badge>
              <Badge variant="secondary">{preview.counts.fieldPolicies} field policy rows</Badge>
              <Badge variant="secondary">{preview.counts.regulatoryProfiles} profile rows</Badge>
              <Badge variant="secondary">{preview.counts.cadenceRules} cadence rows</Badge>
              <Badge variant="secondary">{preview.counts.ruleSeverities} severity rows</Badge>
            </div>
          )}
          <div className="flex gap-2">
            <Input
              placeholder="Bundle Label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              className="w-64 bg-background border-border text-foreground"
            />
            <Button onClick={() => setConfirmOpen(true)}>
              <Plus className="w-4 h-4 mr-2" />
              Publish Bundle
            </Button>
          </div>
        </CardContent>
      </Card>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Publish this configuration snapshot?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            This creates a new immutable configuration bundle from the current live settings. It will not be
            applied to any vessel until you assign it in the Assignments tab.
          </p>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handlePublish} disabled={publishBundle.isPending}>
              {publishBundle.isPending ? "Publishing..." : "Publish"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-foreground text-base">Publish History</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-6 text-muted-foreground">Loading bundles...</div>
          ) : bundles?.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground border-dashed border-border rounded-md">
              <Layers className="w-8 h-8 mx-auto mb-3 opacity-50" />
              <p>No config bundles published yet</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="border-border hover:bg-transparent">
                  <TableHead>Label</TableHead>
                  <TableHead>Contents</TableHead>
                  <TableHead>Published</TableHead>
                  <TableHead>Assigned To</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {bundles?.map((b) => (
                  <TableRow key={b.id} className="border-border hover:bg-muted/50">
                    <TableCell>
                      <div className="font-medium text-foreground">{b.label || "(unlabeled)"}</div>
                      <div className="text-xs text-muted-foreground">by {b.publishedBy}</div>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        <Badge variant="outline">{b.counts.schemaVersions} schemas</Badge>
                        <Badge variant="outline">{b.counts.fieldPolicies} policy</Badge>
                        <Badge variant="outline">{b.counts.regulatoryProfiles} profiles</Badge>
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{new Date(b.publishedAt).toLocaleString()}</TableCell>
                    <TableCell>
                      {assignedToByBundle.has(b.id) ? (
                        <div className="flex flex-col gap-1">
                          {assignedToByBundle.get(b.id)!.map((s, i) => (
                            <span key={i} className="text-xs text-status-ok">
                              {s}
                            </span>
                          ))}
                          {(() => {
                            const rollout = rolloutByBundle.get(b.id);
                            if (!rollout || rollout.total === 0) {
                              return <span className="text-xs text-muted-foreground">No vessels covered</span>;
                            }
                            if (rollout.applied === rollout.total) {
                              return (
                                <span className="text-xs text-status-ok">
                                  Running on {rollout.total} vessel{rollout.total === 1 ? "" : "s"}
                                </span>
                              );
                            }
                            return (
                              <span className="text-xs text-status-warn">
                                Running on {rollout.applied} of {rollout.total} vessel
                                {rollout.total === 1 ? "" : "s"}
                              </span>
                            );
                          })()}
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground">Not assigned</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function AssignmentsTab() {
  const { data: assignments, isLoading, refetch } = trpc.configBundles.listAssignments.useQuery();
  const { data: bundles = [] } = trpc.configBundles.list.useQuery();
  const { data: vessels = [] } = trpc.vessels.list.useQuery();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [assignScope, setAssignScope] = useState<Scope>({ type: "fleet" });
  const [bundleId, setBundleId] = useState("");

  const assignBundle = trpc.configBundles.assign.useMutation({
    onSuccess: () => {
      refetch();
      setDialogOpen(false);
      setBundleId("");
    },
  });

  const canAssign = !!bundleId && (assignScope.type === "fleet" || !!assignScope.key);

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h2 className="text-xl font-heading font-medium text-foreground">Bundle Assignments</h2>
        <Button onClick={() => setDialogOpen(true)}>
          <LinkIcon className="w-4 h-4 mr-2" />
          Assign Bundle
        </Button>
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Assign a Bundle</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <ScopeSelector scope={assignScope} onChange={setAssignScope} vessels={vessels as any} />
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground uppercase font-semibold tracking-wider">Bundle</Label>
              <select
                value={bundleId}
                onChange={(e) => setBundleId(e.target.value)}
                className="w-full bg-background border border-border text-foreground rounded-md h-9 px-2 text-sm"
              >
                <option value="">Select a bundle…</option>
                {bundles.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.label || b.id} ({new Date(b.publishedAt).toLocaleDateString()})
                  </option>
                ))}
              </select>
            </div>
            {!canAssign && (
              <p className="text-xs text-status-warn">Select both a bundle and a target scope to continue.</p>
            )}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={!canAssign || assignBundle.isPending}
              onClick={() => assignBundle.mutate({ scope: assignScope, bundleId })}
            >
              {assignBundle.isPending ? "Assigning..." : "Assign"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Card className="bg-card border-border">
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-6 text-muted-foreground">Loading assignments...</div>
          ) : assignments?.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground border-dashed border-border rounded-md">
              <LinkIcon className="w-8 h-8 mx-auto mb-3 opacity-50" />
              <p>No bundles assigned to any scopes</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="border-border hover:bg-transparent">
                  <TableHead>Scope</TableHead>
                  <TableHead>Bundle</TableHead>
                  <TableHead>Assigned At</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {assignments?.map((a, i) => (
                  <TableRow key={i} className="border-border hover:bg-muted/50">
                    <TableCell className="text-foreground">{scopeLabel(a.scope as Scope, vessels as any)}</TableCell>
                    <TableCell className="text-muted-foreground">{a.bundleLabel || a.bundleId}</TableCell>
                    <TableCell className="text-muted-foreground">{new Date(a.assignedAt).toLocaleString()}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
