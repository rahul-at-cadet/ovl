"use client";

import { useRef, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@ovl/ui/components/card";
import { Button } from "@ovl/ui/components/button";
import { Textarea } from "@ovl/ui/components/textarea";
import { Badge } from "@ovl/ui/components/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@ovl/ui/components/table";
import { Upload, ShieldCheck, Archive, FileJson } from "lucide-react";
import { trpc } from "@/lib/trpc";

/**
 * The master catalogue, as a platform super admin sees it.
 *
 * Publishing here makes a schema *available* to every tenant; it does not
 * change what any tenant is using. Tenants adopt deliberately, and a tenant on
 * an older version — or on a fork of one — stays where it is until someone
 * there decides otherwise. That is the point of the model and the reason this
 * screen shows no "roll out to everyone" button.
 *
 * Published versions are immutable. Publishing a version number that already
 * exists is refused rather than overwritten, because tenants pin adoptions to a
 * version id and reports record the version they were captured under.
 */
export function MasterCatalogueTab() {
  const { data: schemas, isLoading, refetch } = trpc.catalogue.master.list.useQuery();
  const preview = trpc.catalogue.master.preview.useMutation();
  const publish = trpc.catalogue.master.publish.useMutation();
  const deprecate = trpc.catalogue.master.deprecate.useMutation();

  const [content, setContent] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [checked, setChecked] = useState<
    | (Awaited<ReturnType<typeof preview.mutateAsync>> & { forContent: string })
    | null
  >(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // A preview is only meaningful for the exact text it was run against —
  // otherwise an edit after validating would publish something nobody checked.
  const previewIsCurrent = checked !== null && checked.forContent === content;

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setContent(await file.text());
    setChecked(null);
    setError(null);
  };

  const handleValidate = async () => {
    setError(null);
    try {
      const result = await preview.mutateAsync({ content });
      setChecked({ ...result, forContent: content });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Validation failed");
    }
  };

  const handlePublish = async () => {
    setError(null);
    try {
      await publish.mutateAsync({ content });
      setContent("");
      setChecked(null);
      await refetch();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Publish failed");
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start gap-3 rounded-md border border-border bg-muted/40 px-4 py-3">
        <ShieldCheck className="w-5 h-5 text-muted-foreground mt-0.5" />
        <p className="text-sm text-muted-foreground">
          Publishing makes a schema available to every tenant. It does not change what any tenant is
          using — each one adopts on its own, and a tenant that has customised a schema keeps its
          copy.
        </p>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-6">
          <Card className="bg-card border-border">
            <CardHeader>
              <CardTitle className="text-foreground">Published schemas</CardTitle>
              <CardDescription>Every version tenants can choose from.</CardDescription>
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <p className="text-muted-foreground text-sm">Loading…</p>
              ) : (schemas ?? []).length === 0 ? (
                <p className="text-muted-foreground text-sm">
                  Nothing published yet. Upload a schema document to get started.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Schema</TableHead>
                      <TableHead>Version</TableHead>
                      <TableHead>Fields</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(schemas ?? []).map((row) => (
                      <TableRow key={row.id}>
                        <TableCell className="font-medium text-foreground">
                          <span className="inline-flex items-center gap-2">
                            <FileJson className="w-4 h-4 text-muted-foreground" />
                            {row.schemaName}
                          </span>
                        </TableCell>
                        <TableCell>{row.version}</TableCell>
                        <TableCell>{row.fieldCount}</TableCell>
                        <TableCell>
                          <Badge variant={row.status === "published" ? "secondary" : "outline"}>
                            {row.status}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right">
                          {row.status === "published" && (
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={deprecate.isPending}
                              onClick={async () => {
                                await deprecate.mutateAsync({ versionId: row.id });
                                await refetch();
                              }}
                              // Deprecating hides a version from new adoptions
                              // and leaves tenants already on it working, which
                              // is why there is no delete here at all.
                              title="Hide from new adoptions. Tenants already using it are unaffected."
                            >
                              <Archive className="w-3 h-3 mr-1" />
                              Deprecate
                            </Button>
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

        <Card className="bg-card border-border h-fit">
          <CardHeader>
            <CardTitle className="text-foreground">Publish a version</CardTitle>
            <CardDescription>
              Schema name and version are read from the document.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <input
              ref={fileInputRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={handleFile}
            />
            <Button variant="outline" className="w-full" onClick={() => fileInputRef.current?.click()}>
              <Upload className="w-4 h-4 mr-2" />
              Choose JSON file
            </Button>

            <Textarea
              value={content}
              onChange={(e) => {
                setContent(e.target.value);
                setChecked(null);
              }}
              placeholder='{ "schemaName": "bunker-report", "version": "3.14", "fields": [ … ] }'
              className="font-mono text-xs h-64"
              spellCheck={false}
            />

            {previewIsCurrent && (
              <div className="rounded-md border border-border px-3 py-2 text-sm space-y-1">
                {checked.valid ? (
                  <>
                    <p className="text-foreground">
                      {checked.schemaName}@{checked.version} — {checked.fieldCount} fields
                    </p>
                    {checked.versionExists && (
                      <p className="text-destructive">
                        This version already exists. Published versions cannot be replaced — use a
                        new version number.
                      </p>
                    )}
                    {checked.diff && (
                      <p className="text-muted-foreground">
                        vs current: +{checked.diff.added.length} added, −{checked.diff.removed.length}{" "}
                        removed, {checked.diff.changed.length} changed
                      </p>
                    )}
                    {checked.diff && checked.diff.removed.length > 0 && (
                      <p className="text-muted-foreground">
                        Removing: {checked.diff.removed.join(", ")}
                      </p>
                    )}
                  </>
                ) : (
                  <ul className="text-destructive list-disc pl-4">
                    {checked.errors.map((e) => (
                      <li key={e}>{e}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            <div className="flex gap-2">
              <Button
                variant="outline"
                className="flex-1"
                onClick={handleValidate}
                disabled={!content.trim() || preview.isPending}
              >
                Validate
              </Button>
              <Button
                className="flex-1"
                onClick={handlePublish}
                disabled={
                  !previewIsCurrent ||
                  !checked?.valid ||
                  checked?.versionExists ||
                  publish.isPending
                }
              >
                Publish
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
