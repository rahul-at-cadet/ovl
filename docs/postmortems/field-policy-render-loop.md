# Field Policy tab: schema/scope hang (infinite render loop)

**Date:** 2026-08-19
**Component:** `apps/web-office/src/app/(dashboard)/configuration/FieldPolicyTab.tsx`
**Symptom:** Switching the Field Policy tab's Schema or Scope selector froze the whole tab — unresponsive, high CPU, no console errors.

## Why this took so long to find

Five prior commits patched real-but-wrong root causes before this one: a Base UI Select's floating-tree registration, a `:has([aria-...])` CSS selector on a shared table row, a disabled virtualizer left over from a debugging session, missing query-key memoization. Each fix was legitimate and each still left the hang in place, because none of them was the actual cause.

The bug produced **zero signal in the places engineers normally look**:
- No console error or warning, in dev or prod builds.
- No extra network requests — the query driving the table was correctly `enabled: false` during the broken state, so watching the network tab (what an earlier debugging pass did) showed nothing wrong.
- No React error boundary trip, no "Maximum update depth exceeded" warning — React's own loop-detection heuristics don't catch a loop that's paced by passive-effect commits rather than synchronous render-phase `setState` calls.

The only way it became visible was directly instrumenting: a temporary `useEffect(() => { console.log("render", ++counter) })` with **no dependency array**, so it fires after every single commit. That showed 2 renders/second in the working case and **~800 renders/second** the instant the scope selector moved to "Vessel Group" or "Specific Vessel" before a key was chosen.

## Root cause

```tsx
// BEFORE — looks completely innocuous
const fields = policyData?.fields || [];
const eventTypes = policyData?.eventTypes || [];
```

`policyData` is the result of a tRPC query that's deliberately disabled (`enabled: false`) whenever the scope selector is on "Vessel Group"/"Specific Vessel" with no key chosen yet — a real, common, and long-lived UI state. While `policyData` is `undefined`, **`policyData?.fields || []` allocates a brand-new array literal on every render.**

That `fields` value (via a `visibleFields` derivation) was passed as `useReactTable({ data: visibleFields, ... })`. `@tanstack/react-table`'s internal reconciliation treats a new `data` reference as "the data changed" and updates its own internal state to match — which triggers a re-render of the host component — which recomputes `fields` as *yet another* new `[]` — forever. Nothing in this cycle ever converges, because the condition that produces the fresh array (`policyData` being `undefined`) never resolves on its own; it only resolves when the user finally picks a group/vessel key and a real query result arrives.

This is the same failure shape as `useSyncExternalStore`'s well-known "`getSnapshot` must be cached" footgun: a reference-identity-based external store subscription paired with a snapshot getter that never returns a stable reference.

## The fix

```tsx
// Module scope — one stable reference for the whole app's lifetime.
const EMPTY_FIELDS: SchemaField[] = [];
const EMPTY_EVENT_TYPES: string[] = [];

// In the component:
const fields = policyData?.fields ?? EMPTY_FIELDS;
const eventTypes = policyData?.eventTypes ?? EMPTY_EVENT_TYPES;
```

Same logical value (an empty array when there's no data yet), but now it's the *same object* on every render, so nothing downstream ever sees a spurious "change." Applied the same fix to `vessels`/`assignments` destructuring defaults in the same file for consistency.

## The general lesson — audit checklist for this pattern

**Any inline `x || []`, `x || {}`, `x ?? []`, `x ?? {}`, or a destructuring default like `const { data: y = [] } = useQuery(...)`, computed directly in a component body (not inside `useMemo`, not backed by a module-level constant) is a landmine** — but only when the resulting value flows into something that does **reference-identity-based** work, not deep-value comparison:

- **High risk** — passed as `data`/a core option to a headless state library hook that does its own internal reconciliation: `useReactTable`, `useVirtualizer`, `useSyncExternalStore`-based stores, form libraries, combobox/menu state managers. This is exactly what caused this bug and can produce a genuine infinite loop.
- **Medium risk** — used as a `useMemo`/`useCallback`/`useEffect` dependency. Defeats memoization (wasted recompute every render) and is worth fixing, but only becomes a loop if the recomputed value itself flows into a `setState` call whose new value is also reference-unstable. Audit each case rather than assuming.
- **Medium/high risk** — passed as a Context Provider's `value` prop. Re-renders every consumer on every provider render regardless of whether the actual data changed.
- **Low/safe** — used purely for rendering (`.map()` in JSX, `.length` checks) with no hook or context downstream. Wasteful in the sense of a throwaway allocation, but not a correctness bug.

**Fix pattern:** hoist the fallback to a module-level `const EMPTY_X: T = ...` outside the component (or wrap the whole expression in `useMemo` if the fallback itself needs to depend on other values) so the reference is stable across renders whenever the "no data" branch is taken.

## Codebase audit (2026-08-19)

Searched both `apps/web-office/src` and `apps/web-vessel/src` for this pattern. Confirmed `@tanstack/react-table`/`@tanstack/react-virtual` are used **only** in `FieldPolicyTab.tsx` (already fixed) — so the exact "High risk" failure mode can't recur elsewhere via those libraries today. No React Context providers exist in either frontend, so that risk category doesn't currently apply either.

Found several **Medium risk** instances of the same anti-pattern (unstable default feeds a `useMemo`/`useEffect` dependency) that haven't caused an observed loop only because the downstream `useMemo` happens to reduce to a stable primitive today — worth hardening proactively rather than waiting for a future edit to turn them into a real loop:

- `apps/web-office/src/app/(dashboard)/configuration/ComplianceTab.tsx:59-68` (`assignments = []` → `current` memo → effect calling `setSelected`), and the same shape repeated at `:140-151` and `:225-235`.
- `apps/web-office/src/app/(dashboard)/configuration/page.tsx:381-397` (`vessels = []` → `assignedToByBundle` memo, JSX-only consumer — wasteful, not loop-inducing).
- `apps/web-office/src/app/(dashboard)/configuration/ScopeSelector.tsx:26-30` (`vessels` prop → `groups` memo, JSX-only).
- `apps/web-vessel/src/app/(dashboard)/reports/page.tsx:22-26` (`reports = []` → `filteredAndSortedReports` memo, JSX-only).

Everything else found (schemas/reports/vessels/users list defaults in various `page.tsx` files, `AppShell.tsx`) is render-only and safe.

**Not yet fixed** — the `ComplianceTab.tsx` instances are the closest analogues to the original bug (their unstable memo output feeds a `setState`-calling effect) and are the best next candidates if this pattern gets revisited.
