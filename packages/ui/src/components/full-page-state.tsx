import type { ComponentType, ReactNode } from "react"

import { cn } from "../lib/utils"

/**
 * A whole-screen message: an icon, a heading, a sentence, and a way out.
 *
 * Both apps render this shape for "not found" and for an unhandled render
 * error — four copies of the same centred layout, circle-framed icon and
 * spacing, differing only in wording. The wording is *meant* to differ: the
 * office says "this app" and offers Fleet Overview, the vessel says "this
 * terminal" and offers the Dashboard. So the layout is shared and the copy
 * stays with the app that speaks it.
 *
 * `tone` picks the icon's framing only. Critical is for a genuine failure —
 * an ordinary dead link is not one, and colouring it red would tell the reader
 * something untrue about what just happened.
 */
function FullPageState({
  icon: Icon,
  tone = "neutral",
  title,
  description,
  reference,
  children,
  className,
}: {
  icon: ComponentType<{ className?: string }>
  tone?: "neutral" | "critical"
  title: string
  description: ReactNode
  /** A support handle for one occurrence, e.g. Next's error digest. */
  reference?: ReactNode
  /** The actions. */
  children?: ReactNode
  className?: string
}) {
  const critical = tone === "critical"

  return (
    <div
      className={cn(
        "min-h-screen bg-background flex items-center justify-center p-6",
        className,
      )}
    >
      <div className="w-full max-w-md text-center space-y-5">
        <div
          className={cn(
            "mx-auto w-12 h-12 rounded-full border flex items-center justify-center",
            critical
              ? "bg-status-critical/10 border-status-critical/25"
              : "bg-muted border-border",
          )}
        >
          <Icon
            className={cn(
              "w-6 h-6",
              critical ? "text-status-critical" : "text-muted-foreground",
            )}
          />
        </div>

        <div className="space-y-2">
          <h1 className="text-lg font-semibold text-foreground">{title}</h1>
          <p className="text-sm text-muted-foreground">{description}</p>
        </div>

        {reference && (
          <p className="text-xs text-muted-foreground font-mono">{reference}</p>
        )}

        {children && (
          <div className="flex items-center justify-center gap-2">{children}</div>
        )}
      </div>
    </div>
  )
}

export { FullPageState }
