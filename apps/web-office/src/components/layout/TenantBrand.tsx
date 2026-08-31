'use client';

import { SparksLogo, SparksMark } from '@ovl/ui/components/sparks-logo';

interface TenantBrandProps {
  /** The customer's company name, or null before it has loaded. */
  name: string | null;
  /** Their uploaded logo as a data URI, or null if they have not set one. */
  logoDataUrl: string | null;
  /** Sidebar collapsed to its icon rail — show a monogram, never a wordmark. */
  collapsed?: boolean;
  /** Tighter type for the mobile header bar, where vertical room is scarce. */
  dense?: boolean;
}

/**
 * Who this workspace belongs to, shown at the top of the shell.
 *
 * Three states, in the order they are preferred:
 *
 *   1. The customer's own logo, when they have uploaded one in Global
 *      Settings. This is the point of the feature — their staff should see
 *      their brand, not ours.
 *   2. Their company name as text, which every tenant has because it is set
 *      when the tenant is provisioned.
 *   3. The SPARKS lockup, for a deployment with no tenant at all, or before
 *      the first request resolves. Falling back to the product is right here:
 *      an empty header looks broken, and there is no customer to name.
 *
 * Sizing is by height with the width left to follow, and every branch is
 * bounded so the header cannot be pushed out of shape by an image whose
 * dimensions we do not control. A customer's logo may be square, or a wide
 * wordmark, or a tall crest; `object-contain` inside a fixed-height box makes
 * all three sit correctly rather than stretching. The height steps up on
 * larger screens, so the logo is legible on a laptop without crowding a phone.
 */
export function TenantBrand({ name, logoDataUrl, collapsed, dense }: TenantBrandProps) {
  // Collapsed to the 70px rail. A wordmark is unreadable at that width, so a
  // monogram of the company's initials stands in — the same convention the
  // account avatar in the header already uses.
  if (collapsed) {
    return (
      <div className="flex w-full justify-center" title={name ?? 'SPARKS'}>
        {logoDataUrl ? (
          <img
            src={logoDataUrl}
            alt={name ?? 'Company logo'}
            className="h-8 w-8 object-contain"
          />
        ) : name ? (
          <span
            className="h-8 w-8 rounded-md bg-muted text-foreground text-xs font-semibold flex items-center justify-center"
            aria-label={name}
          >
            {initials(name)}
          </span>
        ) : (
          <SparksMark className="h-7" />
        )}
      </div>
    );
  }

  if (logoDataUrl) {
    return (
      <img
        src={logoDataUrl}
        alt={name ?? 'Company logo'}
        title={name ?? undefined}
        // Height-bounded and width-bounded: a very wide logo truncates against
        // the sidebar rather than pushing the collapse control off the header.
        className={`${dense ? 'h-8' : 'h-9 lg:h-10'} w-auto max-w-full object-contain object-left`}
      />
    );
  }

  if (name) {
    return (
      <span
        className={`block truncate font-semibold tracking-tight text-foreground ${
          dense ? 'text-sm' : 'text-sm lg:text-base'
        }`}
        title={name}
      >
        {name}
      </span>
    );
  }

  return <SparksLogo className={dense ? 'h-6' : 'h-7 lg:h-8'} />;
}

/**
 * Up to two initials from a company name.
 *
 * Skips the words that carry no identity — "The Norwegian Shipping Company"
 * should read NS, not TN — and falls back to the first two letters when
 * nothing survives the filter.
 */
function initials(name: string): string {
  const skip = new Set(['the', 'of', 'and', 'a', 'as', 'ltd', 'inc', 'llc', 'plc', 'gmbh']);
  const words = name
    .split(/[\s\-_/]+/)
    .filter(Boolean)
    .filter((w) => !skip.has(w.toLowerCase().replace(/[^a-z]/gi, '')));

  const source = words.length ? words : name.split(/\s+/).filter(Boolean);
  const letters = source
    .slice(0, 2)
    .map((w) => w[0])
    .join('');

  return (letters || name.slice(0, 2)).toUpperCase();
}
