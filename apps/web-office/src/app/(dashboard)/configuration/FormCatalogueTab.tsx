"use client";

import { useMemo, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@ovl/ui/components/card";
import { Button } from "@ovl/ui/components/button";
import { Input } from "@ovl/ui/components/input";
import { Label } from "@ovl/ui/components/label";
import { Textarea } from "@ovl/ui/components/textarea";
import { Badge } from "@ovl/ui/components/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@ovl/ui/components/table";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@ovl/ui/components/dialog";
import { ArrowUpCircle, GitFork, X, FileJson, Pencil } from "lucide-react";
import { trpc } from "@/lib/trpc";

/**
 * A tenant's view of the form-schema catalogue.
 *
 * The model this renders: a platform super admin publishes schemas into a
 * shared master catalogue, each tenant chooses which of them to use, and a
 * tenant that wants changes takes a fork rather than editing the master — which
 * it could not do in any case, since its database role holds only SELECT on the
 * catalogue.
 *
 * The screen is built around one deliberate property worth not designing away:
 * a schema this tenant has not adopted is simply not available to its vessels.
 * There is no implicit fallback to master, so "not adopted" is a real state
 * rather than a display detail, and adopting is an action someone has to take.
 */
export function FormCatalogueTab() {
  const utils = trpc.useUtils();
  const { data: entries, isLoading, error: browseError, refetch } = trpc.catalogue.tenant.browse.useQuery();
  const { data: ownVersions, refetch: refetchOwn } = trpc.catalogue.tenant.listOwn.useQuery({});

  // A platform super admin with no tenant selected. They see what the platform
  // publishes, but adoption is a tenant's own act, so there is no fleet here to
  // adopt into.
  const { data: capabilities } = trpc.tenants.capabilities.useQuery();
  const noTenantSelected = !!capabilities?.isSuperAdmin && !capabilities.tenant;

  const adopt = trpc.catalogue.tenant.adopt.useMutation();
  const unadopt = trpc.catalogue.tenant.unadopt.useMutation();
  const fork = trpc.catalogue.tenant.fork.useMutation();
  const updateDraft = trpc.catalogue.tenant.updateDraft.useMutation();
  const publishOwn = trpc.catalogue.tenant.publishOwn.useMutation();

  const [error, setError] = useState<string | null>(null);
  const [forkTarget, setForkTarget] = useState<{ schemaName: string; versionId: string; masterVersion: string } | null>(null);
  const [forkVersion, setForkVersion] = useState("");
  const [editing, setEditing] = useState<{ id: string; label: string; content: string } | null>(null);

  const drafts = useMemo(
    () => (ownVersions ?? []).filter((v) => v.status === "draft"),
    [ownVersions],
  );

  const refreshAll = async () => {
    await Promise.all([refetch(), refetchOwn(), utils.catalogue.tenant.invalidate()]);
  };

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await refreshAll();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    }
  };

  const openFork = (schemaName: string, versionId: string, masterVersion: string) => {
    setForkTarget({ schemaName, versionId, masterVersion });
    // Suggest a name that reads as "our copy of that version" rather than a
    // bare bump, since the fork is a sibling of the master version, not its
    // successor.
    setForkVersion(`${masterVersion}-custom`);
  };

  const confirmFork = async () => {
    if (!forkTarget) return;
    await run(async () => {
      const draft = await fork.mutateAsync({
        masterVersionId: forkTarget.versionId,
        newVersion: forkVersion.trim(),
      });
      setForkTarget(null);
      setEditing({
        id: draft.id,
        label: `${draft.schemaName}@${draft.version}`,
        content: JSON.stringify(draft.content, null, 2),
      });
    });
  };

  const saveDraft = async () => {
    if (!editing) return;
    await run(async () => {
      await updateDraft.mutateAsync({ versionId: editing.id, content: editing.content });
      setEditing(null);
    });
  };

  const saveAndPublish = async () => {
    if (!editing) return;
    await run(async () => {
      await updateDraft.mutateAsync({ versionId: editing.id, content: editing.content });
      await publishOwn.mutateAsync({ versionId: editing.id });
      setEditing(null);
    });
  };

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-foreground">Form Schemas</CardTitle>
          <CardDescription>
            {noTenantSelected
              ? 'Every schema the platform publishes for tenants to adopt. Select a tenant to see which of these its fleet uses, and to adopt or customise one on its behalf.'
              : 'Schemas published by the platform, and the version your fleet uses. A schema you have not adopted is not available to your vessels — there is no automatic default.'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-muted-foreground text-sm">Loading catalogue…</p>
          ) : browseError ? (
            /* A failed request is not an empty catalogue. This said "the
             * platform has not published any schemas yet" for every failure,
             * which is a statement about the platform rather than about the
             * request — and it was being shown while five schemas sat
             * published in the catalogue. */
            <div className="text-sm">
              <p className="text-status-critical font-medium">Couldn&apos;t load the catalogue</p>
              <p className="text-muted-foreground text-xs mt-1">{browseError.message}</p>
            </div>
          ) : (entries ?? []).length === 0 ? (
            <p className="text-muted-foreground text-sm">
              The platform has not published any schemas yet.
            </p>
          ) : (
            // Scrolls inside the card rather than letting the page scroll
            // sideways. Without this the whole layout shifts and the Schema
            // column — the one that says which row you are looking at — is the
            // first thing to disappear. table-fixed keeps the header cells and
            // the body cells on the same column widths; without it the widest
            // cell in each column wins and the header drifts out of line with
            // the data under it.
            <div className="overflow-x-auto">
              <Table className="table-fixed min-w-[640px]">
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[190px]">Schema</TableHead>
                    <TableHead className="w-[100px]">Platform</TableHead>
                    <TableHead>In use by your fleet</TableHead>
                    <TableHead className="w-[160px] text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(entries ?? []).map((entry) => (
                    <TableRow key={entry.schemaName}>
                      <TableCell className="font-medium text-foreground">
                        <span className="flex items-center gap-2 min-w-0">
                          <FileJson className="w-4 h-4 shrink-0 text-muted-foreground" />
                          <span className="truncate" title={entry.schemaName}>
                            {entry.schemaName}
                          </span>
                        </span>
                      </TableCell>

                      <TableCell>
                        <span className="inline-flex items-center gap-1.5">
                          {entry.masterVersion ?? "—"}
                          {entry.upgradeAvailable && (
                            <ArrowUpCircle className="w-3.5 h-3.5 text-primary" aria-label="update available" />
                          )}
                        </span>
                      </TableCell>

                      {/* Version and provenance together: "3.13-custom · your fork"
                          reads as one fact, and splitting them cost a column. */}
                      <TableCell>
                        {!entry.adopted ? (
                          <span className="text-muted-foreground">not adopted</span>
                        ) : (
                          <span className="inline-flex items-center gap-2">
                            <span className="text-foreground">{entry.adoptedVersion}</span>
                            {entry.isFork ? (
                              <Badge variant="outline" className="gap-1">
                                <GitFork className="w-3 h-3" />
                                your fork
                              </Badge>
                            ) : entry.adoptedSource === "tenant" ? (
                              <Badge variant="outline">your own</Badge>
                            ) : (
                              <Badge variant="secondary">platform</Badge>
                            )}
                          </span>
                        )}
                      </TableCell>

                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          {entry.masterVersionId && (
                            <>
                              <Button
                                size="sm"
                                variant={
                                  entry.adopted && !entry.upgradeAvailable ? "ghost" : "default"
                                }
                                disabled={adopt.isPending || noTenantSelected}
                                onClick={() =>
                                  run(() => adopt.mutateAsync({ versionId: entry.masterVersionId! }))
                                }
                                title={
                                  noTenantSelected
                                    ? 'Select a tenant to adopt this on its behalf'
                                    : `Use platform version ${entry.masterVersion}`
                                }
                              >
                                {entry.adopted
                                  ? entry.upgradeAvailable
                                    ? "Update"
                                    : "Re-adopt"
                                  : "Adopt"}
                              </Button>

                              <Button
                                size="sm"
                                variant="outline"
                                className="px-2"
                                disabled={fork.isPending || noTenantSelected}
                                onClick={() =>
                                  openFork(
                                    entry.schemaName,
                                    entry.masterVersionId!,
                                    entry.masterVersion ?? "1.0",
                                  )
                                }
                                title="Customise — take your own copy so you can change it"
                                aria-label={`Customise ${entry.schemaName}`}
                              >
                                <GitFork className="w-4 h-4" />
                              </Button>
                            </>
                          )}

                          {entry.adopted && (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="px-2"
                              disabled={unadopt.isPending}
                              onClick={() =>
                                run(() => unadopt.mutateAsync({ schemaName: entry.schemaName }))
                              }
                              title="Stop using this schema"
                              aria-label={`Stop using ${entry.schemaName}`}
                            >
                              <X className="w-4 h-4" />
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {drafts.length > 0 && (
        <Card className="bg-card border-border">
          <CardHeader>
            <CardTitle className="text-foreground">Drafts</CardTitle>
            <CardDescription>
              Not in use by any vessel until published. Publishing a draft switches your fleet onto
              it.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {drafts.map((draft) => (
              <div
                key={draft.id}
                className="flex items-center justify-between rounded-md border border-border px-4 py-3"
              >
                <div>
                  <p className="text-foreground font-medium">
                    {draft.schemaName}@{draft.version}
                  </p>
                  <p className="text-muted-foreground text-sm">
                    {draft.origin === "fork"
                      ? `forked from platform ${draft.forkedFromVersion}`
                      : "authored here"}
                  </p>
                </div>
                <div className="space-x-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      setEditing({
                        id: draft.id,
                        label: `${draft.schemaName}@${draft.version}`,
                        content: JSON.stringify(draft.content, null, 2),
                      })
                    }
                  >
                    <Pencil className="w-3 h-3 mr-1" />
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    disabled={publishOwn.isPending}
                    onClick={() => run(() => publishOwn.mutateAsync({ versionId: draft.id }))}
                  >
                    Publish
                  </Button>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <Dialog open={forkTarget !== null} onOpenChange={(open) => !open && setForkTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Customise {forkTarget?.schemaName}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              This takes your own copy of platform version {forkTarget?.masterVersion}. The
              platform&apos;s schema is not changed, and your copy stays yours when the platform
              publishes a new version.
            </p>
            <div className="space-y-2">
              <Label htmlFor="fork-version">Your version name</Label>
              <Input
                id="fork-version"
                value={forkVersion}
                onChange={(e) => setForkVersion(e.target.value)}
                placeholder="3.13-custom"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setForkTarget(null)}>
              Cancel
            </Button>
            <Button onClick={confirmFork} disabled={!forkVersion.trim() || fork.isPending}>
              Create copy
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Edit {editing?.label}</DialogTitle>
          </DialogHeader>
          <Textarea
            value={editing?.content ?? ""}
            onChange={(e) => setEditing((prev) => (prev ? { ...prev, content: e.target.value } : prev))}
            className="font-mono text-xs h-[420px]"
            spellCheck={false}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button variant="outline" onClick={saveDraft} disabled={updateDraft.isPending}>
              Save draft
            </Button>
            <Button onClick={saveAndPublish} disabled={updateDraft.isPending || publishOwn.isPending}>
              Save and publish
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
