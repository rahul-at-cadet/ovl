import type { ComponentType } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Info,
  Minus,
  MessageSquare,
  PencilLine,
  XCircle,
} from 'lucide-react';

import { cn } from '../lib/utils';

/**
 * The one place a status turns into colour in this app.
 *
 * Every role resolves through the --status-* tokens each app defines in its
 * own globals.css, never a raw Tailwind palette class. Five pages across the
 * two apps used to carry inline `bg-emerald-500/10 text-emerald-400`-style
 * maps, and they had already drifted apart — a report shown as blue
 * "Submitted" on the ledger was green on the detail page.
 *
 * That indirection is also what makes the vessel app's Night palette work: a
 * literal green chip stays green in Night mode and undoes the S-52
 * dark-adaptation the palette exists to protect. A literal can't follow a
 * theme; a token can.
 *
 * Colour is never the only channel: every badge renders an icon chosen by
 * *status*, not by role, so state survives greyscale, red-green colour
 * blindness, and Night mode — where every role deliberately sits inside the
 * same warm hue band and shape is what actually distinguishes them.
 */
export type StatusRole = 'ok' | 'warn' | 'attention' | 'critical' | 'info' | 'neutral';

const ROLE_CLASS: Record<StatusRole, string> = {
  ok: 'text-status-ok bg-status-ok/10 border-status-ok/25',
  warn: 'text-status-warn bg-status-warn/10 border-status-warn/25',
  attention: 'text-status-attention bg-status-attention/10 border-status-attention/25',
  critical: 'text-status-critical bg-status-critical/10 border-status-critical/25',
  info: 'text-status-info bg-status-info/10 border-status-info/25',
  neutral: 'text-muted-foreground bg-muted/60 border-border',
};

const ROLE_ICON: Record<StatusRole, ComponentType<{ className?: string }>> = {
  ok: CheckCircle2,
  warn: AlertTriangle,
  attention: AlertCircle,
  critical: XCircle,
  info: Info,
  neutral: Minus,
};

interface StatusDefinition {
  role: StatusRole;
  label: string;
  icon: ComponentType<{ className?: string }>;
}

/**
 * Report lifecycle states, as emitted by either API. Keep in step with
 * apps/api-office/src/reports and apps/api-vessel/src/reports — an unknown
 * state falls back to a neutral badge carrying the raw value rather than
 * silently rendering nothing.
 */
const STATUS: Record<string, StatusDefinition> = {
  draft: { role: 'warn', label: 'Draft', icon: PencilLine },
  ready: { role: 'info', label: 'Ready', icon: CheckCircle2 },
  submitted: { role: 'ok', label: 'Submitted', icon: CheckCircle2 },
  remarked: { role: 'attention', label: 'Remarked', icon: MessageSquare },
  invalidated: { role: 'critical', label: 'Invalidated', icon: XCircle },
  overdue: { role: 'critical', label: 'Overdue', icon: Clock },
  active: { role: 'ok', label: 'Active', icon: CheckCircle2 },
  inactive: { role: 'neutral', label: 'Inactive', icon: Minus },
};

export function statusRole(status: string): StatusRole {
  return STATUS[status]?.role ?? 'neutral';
}

interface StatusBadgeProps {
  /** A known lifecycle state — resolves label, icon and role together. */
  status?: string;
  /** Explicit role, for states with no entry in the map above. */
  role?: StatusRole;
  /** Overrides the label derived from `status`. */
  label?: string;
  /** Hide the icon only where an adjacent icon already carries the meaning. */
  showIcon?: boolean;
  size?: 'sm' | 'md';
  className?: string;
}

export function StatusBadge({
  status,
  role,
  label,
  showIcon = true,
  size = 'md',
  className,
}: StatusBadgeProps) {
  const known = status ? STATUS[status] : undefined;
  const resolvedRole = role ?? known?.role ?? 'neutral';
  const resolvedLabel =
    label ?? known?.label ?? (status ? status.charAt(0).toUpperCase() + status.slice(1) : '');
  const Icon = known?.icon ?? ROLE_ICON[resolvedRole];

  return (
    <span
      data-slot="status-badge"
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md border font-medium whitespace-nowrap',
        size === 'sm' ? 'px-1.5 py-0.5 text-[0.7rem]' : 'px-2 py-1 text-xs',
        ROLE_CLASS[resolvedRole],
        className,
      )}
    >
      {showIcon && <Icon className={size === 'sm' ? 'w-3 h-3 shrink-0' : 'w-3.5 h-3.5 shrink-0'} />}
      {resolvedLabel}
    </span>
  );
}

/**
 * The compact form, for tables and map markers where a full badge doesn't
 * fit. Carries its label in `title` and as visually-hidden text so the
 * meaning survives without the colour.
 */
export function StatusDot({
  status,
  role,
  label,
  className,
}: Pick<StatusBadgeProps, 'status' | 'role' | 'label' | 'className'>) {
  const known = status ? STATUS[status] : undefined;
  const resolvedRole = role ?? known?.role ?? 'neutral';
  const resolvedLabel = label ?? known?.label ?? status ?? '';
  const ROLE_FILL: Record<StatusRole, string> = {
    ok: 'bg-status-ok',
    warn: 'bg-status-warn',
    attention: 'bg-status-attention',
    critical: 'bg-status-critical',
    info: 'bg-status-info',
    neutral: 'bg-muted-foreground',
  };

  return (
    <span className={cn('inline-flex items-center gap-1.5', className)} title={resolvedLabel}>
      <span className={cn('inline-block size-2 rounded-full shrink-0', ROLE_FILL[resolvedRole])} />
      <span className="sr-only">{resolvedLabel}</span>
    </span>
  );
}
