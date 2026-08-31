# @ovl/ui

The design system shared by `web-office` and `web-vessel`.

Before this package existed, twelve of these components lived as byte-identical
copies in both apps, and two had already drifted: `theme-toggle` rendered its
menu on `bg-card` in one app and `bg-background` in the other, for the same
control. Every fix had to be made twice, correctly, or the apps diverged
further.

## Consuming it

The package ships **source**, not a build. Both apps list it in
`transpilePackages`, so Next compiles the `.tsx` directly and there is no build
step to remember.

```tsx
import { Button } from '@ovl/ui/components/button';
import { StatusBadge } from '@ovl/ui/components/status-badge';
import { cn } from '@ovl/ui/lib/utils';
```

## Colour

**This package defines no colours of its own.** Every component styles itself
through theme tokens — `bg-card`, `text-muted-foreground`, `border-border`, and
the semantic status scale `text-status-ok | -warn | -attention | -critical |
-info` — which each app defines in its own `src/app/globals.css`.

That is deliberate and it is the whole point. The two apps have genuinely
different palettes: the office app is the SPARKS brand teal, while the
vessel app runs an IHO S-52 Night palette built to preserve a watchkeeper's
dark adaptation at sea. A component that hardcoded `text-emerald-400` would
look correct in one app and actively unsafe in the other. Because the
components only ever name a *role*, the same `<StatusBadge status="submitted">`
renders green on shore and a low-saturation tan on a darkened bridge.

An ESLint rule in each app rejects raw Tailwind palette classes. Keep this
package to the same standard.

## Tailwind

Tailwind ignores `node_modules`, and npm workspaces symlink this package there,
so class names used here would otherwise never be scanned. Each app's
`globals.css` carries an explicit `@source` line pointing at
`packages/ui/src`. If a component's styling silently does nothing in one app,
check that line first.
