"use client"

import * as React from "react"
import { Toast as ToastPrimitive } from "@base-ui/react/toast"
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from "lucide-react"

import { cn } from "../lib/utils"

const ToastProvider = ToastPrimitive.Provider
const useToastManager = ToastPrimitive.useToastManager

const TYPE_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  success: CheckCircle2,
  error: XCircle,
  warning: AlertTriangle,
  info: Info,
}

const TYPE_ACCENT: Record<string, string> = {
  success: "border-status-ok/30 [&_[data-slot=toast-icon]]:text-status-ok",
  error: "border-status-critical/30 [&_[data-slot=toast-icon]]:text-status-critical",
  warning: "border-status-warn/30 [&_[data-slot=toast-icon]]:text-status-warn",
  info: "border-border [&_[data-slot=toast-icon]]:text-muted-foreground",
}

function ToastList() {
  const { toasts } = useToastManager()

  return (
    <ToastPrimitive.Portal>
      <ToastPrimitive.Viewport
        data-slot="toast-viewport"
        className="fixed bottom-4 left-4 right-4 z-[100] flex flex-col gap-2 outline-none sm:left-auto sm:w-full sm:max-w-sm"
      >
        {toasts.map((toast) => {
          const Icon = TYPE_ICON[toast.type ?? "info"] ?? Info
          return (
            <ToastPrimitive.Root
              key={toast.id}
              toast={toast}
              data-slot="toast"
              className={cn(
                "relative flex items-start gap-3 rounded-lg border bg-background/95 p-4 shadow-xl backdrop-blur-md transition-all",
                "data-starting-style:translate-x-full data-starting-style:opacity-0",
                "data-ending-style:opacity-0",
                "data-[swipe-direction]:transition-none",
                TYPE_ACCENT[toast.type ?? "info"]
              )}
            >
              <Icon data-slot="toast-icon" className="w-5 h-5 mt-0.5 shrink-0" />
              <div className="flex-1 min-w-0 space-y-0.5">
                <ToastPrimitive.Title data-slot="toast-title" className="text-sm font-semibold text-foreground" />
                <ToastPrimitive.Description
                  data-slot="toast-description"
                  className="text-xs text-muted-foreground empty:hidden"
                />
              </div>
              <ToastPrimitive.Close
                data-slot="toast-close"
                aria-label="Dismiss"
                className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
              >
                <X className="w-4 h-4" />
              </ToastPrimitive.Close>
            </ToastPrimitive.Root>
          )
        })}
      </ToastPrimitive.Viewport>
    </ToastPrimitive.Portal>
  )
}

function Toaster() {
  return <ToastList />
}

export { ToastProvider, Toaster, useToastManager }
