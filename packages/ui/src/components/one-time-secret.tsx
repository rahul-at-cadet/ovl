import * as React from "react"

import { cn } from "../lib/utils"
import { CopyField } from "./copy-field"

/**
 * A secret the user gets exactly one chance to copy.
 *
 * Both apps mint temporary passwords in several places — onboarding an office
 * user, resetting a password, provisioning a tenant and its first admin — and
 * each had grown its own arrangement of a label, a CopyField and a "you won't
 * see this again" warning. They had already drifted: different wording,
 * different emphasis, and in one case no warning at all, which is the one
 * detail that actually matters here.
 *
 * The warning is not optional for that reason. A caller can reword it, but it
 * cannot be switched off.
 */
function OneTimeSecret({
  value,
  label = "Temporary password",
  warning = "Copy this now — it is not shown again.",
  className,
  ...props
}: Omit<React.ComponentProps<"div">, "children"> & {
  value: string
  label?: string
  warning?: string
}) {
  return (
    <div
      data-slot="one-time-secret"
      className={cn("rounded-xl border border-border bg-card p-4", className)}
      {...props}
    >
      <p className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <CopyField value={value} />
      <p className="mt-3 text-xs text-status-warn">{warning}</p>
    </div>
  )
}

export { OneTimeSecret }
