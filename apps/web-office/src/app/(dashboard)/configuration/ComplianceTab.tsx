"use client";

import { useEffect, useMemo, useState } from "react";
import { trpc } from "@/lib/trpc";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Lock } from "lucide-react";
import { ScopeSelector } from "./ScopeSelector";
import {
  ALL_PROFILES,
  PROFILE_LABELS,
  RULE_LABELS,
  ruleLabel,
  scopeLabel,
  scopesEqual,
  type Scope,
} from "@/lib/config/complianceLogic";

const PRECEDENCE_TEXT =
  "Most specific wins: a vessel-level setting overrides its group, which overrides fleet-wide. Regulatory profiles are the exception — enabling one anywhere enables it everywhere it applies.";

function PrecedenceBanner() {
  return (
    <div className="rounded-md border border-emerald-300 bg-emerald-50 dark:border-emerald-900/50 dark:bg-emerald-950/30 px-4 py-2 text-xs text-emerald-700 dark:text-emerald-300">
      {PRECEDENCE_TEXT}
    </div>
  );
}

export function ComplianceTab() {
  return (
    <div className="space-y-6">
      <PrecedenceBanner />
      <Tabs defaultValue="profiles" orientation="horizontal">
        <TabsList className="mb-4">
          <TabsTrigger value="profiles">Regulatory Profiles</TabsTrigger>
          <TabsTrigger value="cadence">Cadence Rules</TabsTrigger>
          <TabsTrigger value="severities">Rule Severities</TabsTrigger>
        </TabsList>
        <TabsContent value="profiles">
          <RegulatoryProfilesPanel />
        </TabsContent>
        <TabsContent value="cadence">
          <CadenceRulesPanel />
        </TabsContent>
        <TabsContent value="severities">
          <RuleSeveritiesPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function RegulatoryProfilesPanel() {
  const { data: vessels = [] } = trpc.vessels.list.useQuery();
  const { data: assignments = [], refetch } = trpc.compliance.listProfiles.useQuery();
  const [scope, setScope] = useState<Scope>({ type: "fleet" });
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const current = useMemo(() => assignments.find((a) => scopesEqual(a.scope as Scope, scope)), [assignments, scope]);

  useEffect(() => {
    setSelected(new Set(current?.profiles ?? []));
  }, [current]);

  const save = trpc.compliance.saveProfile.useMutation({ onSuccess: () => refetch() });

  const toggle = (p: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  };

  return (
    <div className="space-y-6">
      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-foreground text-base">Regulatory Profiles</CardTitle>
          <CardDescription>Which reporting obligations apply at this scope.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <ScopeSelector scope={scope} onChange={setScope} vessels={vessels as any} />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {ALL_PROFILES.map((p) => (
              <button
                key={p}
                onClick={() => toggle(p)}
                className={`text-left rounded-md border px-4 py-3 text-sm transition-colors ${
                  selected.has(p)
                    ? "border-emerald-600 bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300"
                    : "border-border bg-background text-foreground hover:border-border"
                }`}
              >
                {PROFILE_LABELS[p] ?? p}
              </button>
            ))}
          </div>
          <Button
            disabled={scope.type !== "fleet" && !scope.key}
            onClick={() => save.mutate({ scope, profiles: [...selected] })}
            className="bg-blue-600 hover:bg-blue-700 text-white"
          >
            {save.isPending ? "Saving..." : current ? "Update" : "Save"}
          </Button>
        </CardContent>
      </Card>

      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-foreground text-base">Current Assignments</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {assignments.length === 0 && <p className="text-sm text-muted-foreground">No profile assignments yet.</p>}
          {assignments.map((a, i) => (
            <div key={i} className="flex items-center justify-between border-b border-border py-2 text-sm">
              <span className="text-foreground">{scopeLabel(a.scope as Scope, vessels as any)}</span>
              <div className="flex gap-1 flex-wrap">
                {(a.profiles as string[]).map((p) => (
                  <Badge key={p} variant="secondary">
                    {PROFILE_LABELS[p] ?? p}
                  </Badge>
                ))}
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

function CadenceRulesPanel() {
  const { data: vessels = [] } = trpc.vessels.list.useQuery();
  const { data: rules = [], refetch } = trpc.compliance.listCadenceRules.useQuery();
  const [scope, setScope] = useState<Scope>({ type: "fleet" });
  const [minInterval, setMinInterval] = useState("24");
  const [maxGap, setMaxGap] = useState("12");

  const current = useMemo(() => rules.find((r) => scopesEqual(r.scope as Scope, scope)), [rules, scope]);

  useEffect(() => {
    setMinInterval(String(current?.minReportIntervalHours ?? 24));
    setMaxGap(String(current?.maxGapHours ?? 12));
  }, [current]);

  const save = trpc.compliance.saveCadenceRule.useMutation({ onSuccess: () => refetch() });

  const minNum = Number(minInterval);
  const maxNum = Number(maxGap);
  const valid = Number.isFinite(minNum) && minNum > 0 && Number.isFinite(maxNum) && maxNum > 0;

  return (
    <div className="space-y-6">
      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-foreground text-base">Cadence Rule</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <ScopeSelector scope={scope} onChange={setScope} vessels={vessels as any} />
          <div className="flex gap-4">
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground uppercase font-semibold tracking-wider">
                Min report interval (hours)
              </label>
              <Input
                value={minInterval}
                onChange={(e) => setMinInterval(e.target.value)}
                className="w-32 bg-background border-border"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground uppercase font-semibold tracking-wider">
                Max gap (hours)
              </label>
              <Input value={maxGap} onChange={(e) => setMaxGap(e.target.value)} className="w-32 bg-background border-border" />
            </div>
          </div>
          {valid && (
            <p className="text-sm text-muted-foreground">
              Vessels {scopeLabel(scope, vessels as any).toLowerCase()} must report at least every {maxNum} hours, with no more
              than {minNum} hours between the start of consecutive reporting windows.
            </p>
          )}
          {!valid && <p className="text-sm text-amber-400">Both values must be positive numbers.</p>}
          <Button
            disabled={!valid || (scope.type !== "fleet" && !scope.key)}
            onClick={() => save.mutate({ scope, minReportIntervalHours: minNum, maxGapHours: maxNum })}
            className="bg-blue-600 hover:bg-blue-700 text-white"
          >
            {save.isPending ? "Saving..." : current ? "Update" : "Save"}
          </Button>
        </CardContent>
      </Card>

      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-foreground text-base">Current Cadence Rules</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {rules.length === 0 && <p className="text-sm text-muted-foreground">No cadence rules set yet.</p>}
          {rules.map((r, i) => (
            <div key={i} className="flex items-center justify-between border-b border-border py-2 text-sm">
              <span className="text-foreground">{scopeLabel(r.scope as Scope, vessels as any)}</span>
              <span className="text-muted-foreground">
                max gap {r.maxGapHours}h · min interval {r.minReportIntervalHours}h
              </span>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

const SEVERITY_OPTIONS = ["default", "error", "warning", "info"] as const;

function RuleSeveritiesPanel() {
  const { data: vessels = [] } = trpc.vessels.list.useQuery();
  const { data: catalog } = trpc.compliance.ruleCatalog.useQuery();
  const { data: assignments = [], refetch } = trpc.compliance.listRuleSeverities.useQuery();
  const [scope, setScope] = useState<Scope>({ type: "fleet" });
  const [severities, setSeverities] = useState<Record<string, string>>({});

  const current = useMemo(() => assignments.find((a) => scopesEqual(a.scope as Scope, scope)), [assignments, scope]);

  useEffect(() => {
    setSeverities((current?.severities as Record<string, string>) ?? {});
  }, [current]);

  const save = trpc.compliance.saveRuleSeverity.useMutation({ onSuccess: () => refetch() });

  const setSeverity = (ruleId: string, value: string) => {
    setSeverities((prev) => {
      const next = { ...prev };
      if (value === "default") delete next[ruleId];
      else next[ruleId] = value;
      return next;
    });
  };

  return (
    <div className="space-y-6">
      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-foreground text-base">Rule Severity Overrides</CardTitle>
          <CardDescription>Override how strictly plausibility/continuity rules are enforced.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <ScopeSelector scope={scope} onChange={setScope} vessels={vessels as any} />
          <div className="divide-y divide-slate-800 border border-border rounded-md">
            {(catalog?.overridable ?? Object.keys(RULE_LABELS)).map((ruleId) => (
              <div key={ruleId} className="flex items-center justify-between px-4 py-2">
                <span className="text-sm text-foreground">{ruleLabel(ruleId)}</span>
                <Select value={severities[ruleId] ?? "default"} onValueChange={(v: any) => v && setSeverity(ruleId, v)}>
                  <SelectTrigger className="w-32 bg-background border-border">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SEVERITY_OPTIONS.map((s) => (
                      <SelectItem key={s} value={s}>
                        {s === "default" ? "(default)" : s}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ))}
            {(catalog?.hard ?? []).map((ruleId) => (
              <div key={ruleId} className="flex items-center justify-between px-4 py-2 opacity-60">
                <span className="text-sm text-foreground">{ruleLabel(ruleId)}</span>
                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                  <Lock className="w-3 h-3" /> Error (locked)
                </span>
              </div>
            ))}
          </div>
          <Button
            disabled={scope.type !== "fleet" && !scope.key}
            onClick={() => save.mutate({ scope, severities })}
            className="bg-blue-600 hover:bg-blue-700 text-white"
          >
            {save.isPending ? "Saving..." : current ? "Update" : "Save"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
