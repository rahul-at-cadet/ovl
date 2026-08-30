'use client'

import * as React from "react"

import { Button } from "./button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./dialog"

/**
 * A confirm-then-report dialog: ask, do the thing, show what came back.
 *
 * Written because both apps had hand-assembled this same two-step dialog
 * several times over — reset a password, onboard a user, provision a tenant —
 * and the copies had diverged in ways that were not deliberate. Most of them
 * also nested `DialogFooter` inside a wrapper `<div>`, which looks harmless
 * and is not: DialogFooter's `-mx-4 -mb-4` exists to cancel DialogContent's
 * own `p-4`, so one level down it cancels the wrapper's box instead, the
 * footer stops short of the dialog's edge, and a strip of dialog background
 * shows underneath it. Six dialogs had that defect.
 *
 * Getting the structure right once, here, is the point: callers supply
 * content and actions and cannot place the footer wrongly.
 */
function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  error,
  confirmLabel = "Confirm",
  pendingLabel,
  cancelLabel = "Cancel",
  confirmVariant = "default",
  confirmDisabled = false,
  pending = false,
  onConfirm,
  /** When set, the dialog shows this instead of the prompt, with a single Done. */
  result,
  doneLabel = "Done",
  className,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: React.ReactNode
  children?: React.ReactNode
  error?: string | null
  confirmLabel?: string
  pendingLabel?: string
  cancelLabel?: string
  confirmVariant?: React.ComponentProps<typeof Button>["variant"]
  confirmDisabled?: boolean
  pending?: boolean
  onConfirm?: () => void
  result?: React.ReactNode
  doneLabel?: string
  className?: string
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={className}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>

        {result ? (
          <>
            <div className="space-y-3 py-1">{result}</div>
            {/* Direct child of DialogContent — see this component's own note. */}
            <DialogFooter>
              <Button onClick={() => onOpenChange(false)}>{doneLabel}</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <div className="space-y-3 py-1">
              {description && (
                <div className="text-sm text-muted-foreground">{description}</div>
              )}
              {children}
              {error && <p className="text-xs text-status-critical">{error}</p>}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                {cancelLabel}
              </Button>
              <Button
                variant={confirmVariant}
                disabled={confirmDisabled || pending}
                onClick={onConfirm}
              >
                {pending ? (pendingLabel ?? `${confirmLabel}...`) : confirmLabel}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

export { ConfirmDialog }
