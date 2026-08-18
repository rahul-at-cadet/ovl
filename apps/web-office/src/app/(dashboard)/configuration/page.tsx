"use client";

import { useMemo, useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Upload, Plus, FileJson, Layers, Link as LinkIcon, ShieldAlert, ScrollText, Ship } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { FieldPolicyTab } from "./FieldPolicyTab";
import { ComplianceTab } from "./ComplianceTab";
import { VesselConfigsTab } from "./VesselConfigsTab";
import { ScopeSelector } from "./ScopeSelector";
import { scopeLabel, type Scope } from "@/lib/config/complianceLogic";

export default function ConfigurationPage() {
  const [activeTab, setActiveTab] = useState("schemas");

  return (
    <div className="p-8">
      <div className="flex justify-between items-center mb-8">
        <div>
          <h1 className="text-3xl font-heading font-bold text-foreground">Fleet Configuration</h1>
          <p className="text-muted-foreground mt-2">Manage dynamic schemas and push config bundles to edge nodes.</p>
        </div>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab} orientation="horizontal" className="w-full">
        <TabsList className="mb-6">
          <TabsTrigger value="schemas" className="flex items-center gap-2">
            <FileJson className="w-4 h-4" />
            Schemas
          </TabsTrigger>
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

  const [schemaName, setSchemaName] = useState("");
  const [version, setVersion] = useState("");
  const [content, setContent] = useState("");
  const [error, setError] = useState<string | null>(null);

  const handleUpload = async () => {
    setError(null);
    if (!schemaName || !version || !content) {
      setError("Please fill in all fields");
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
              <div className="text-center py-12 text-muted-foreground border border-dashed border-border rounded-lg">
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
                        <TableCell><span className="bg-blue-900/30 text-blue-400 px-2 py-0.5 rounded text-xs font-mono">{s.version}</span></TableCell>
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
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label>Schema Name</Label>
              <Input 
                placeholder="e.g. log-abstract" 
                value={schemaName}
                onChange={e => setSchemaName(e.target.value)}
                className="bg-background border-border text-foreground" 
              />
            </div>
            <div className="space-y-2">
              <Label>Version Tag</Label>
              <Input 
                placeholder="e.g. 1.0.0" 
                value={version}
                onChange={e => setVersion(e.target.value)}
                className="bg-background border-border text-foreground" 
              />
            </div>
            <div className="space-y-2">
              <Label>JSON Content</Label>
              <textarea 
                placeholder="{ ... }" 
                rows={10} 
                value={content}
                onChange={e => setContent(e.target.value)}
                className="w-full bg-background border border-border text-foreground font-mono text-sm rounded-md p-3 focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent" 
              />
            </div>
            
            {error && <p className="text-red-400 text-sm">{error}</p>}
            
            <Button onClick={handleUpload} disabled={publishSchema.isPending} className="w-full bg-blue-600 hover:bg-blue-700 text-white">
              <Upload className="w-4 h-4 mr-2" />
              {publishSchema.isPending ? "Publishing..." : "Publish Immutable Version"}
            </Button>
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
            <Button onClick={() => setConfirmOpen(true)} className="bg-emerald-600 hover:bg-emerald-700 text-white">
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
            <Button onClick={handlePublish} disabled={publishBundle.isPending} className="bg-emerald-600 hover:bg-emerald-700 text-white">
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
            <div className="text-center py-12 text-muted-foreground border-dashed border-border rounded-lg">
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
                            <span key={i} className="text-xs text-emerald-400">
                              {s}
                            </span>
                          ))}
                          <span className="text-xs text-muted-foreground">Pending next sync</span>
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
        <Button onClick={() => setDialogOpen(true)} className="bg-blue-600 hover:bg-blue-700 text-white">
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
              <p className="text-xs text-amber-400">Select both a bundle and a target scope to continue.</p>
            )}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={!canAssign || assignBundle.isPending}
              onClick={() => assignBundle.mutate({ scope: assignScope, bundleId })}
              className="bg-blue-600 hover:bg-blue-700 text-white"
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
            <div className="text-center py-12 text-muted-foreground border-dashed border-border rounded-lg">
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
