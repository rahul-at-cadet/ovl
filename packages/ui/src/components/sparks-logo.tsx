/**
 * The SPARKS brand marks.
 *
 * Two of them, because the lockup and the icon are not interchangeable and
 * using one where the other belongs is the usual way product branding goes
 * wrong.
 *
 * `SparksLogo` is the full lockup — the wave motif above the SPARKS wordmark.
 * It *contains the product name*, so it must never be placed next to a
 * separate "SPARKS" text label; that reads as saying the name twice. Use it
 * where there is horizontal room: the sign-in card, the "powered by" line.
 *
 * `SparksMark` is the wave motif alone, square and centred. Use it where the
 * lockup would be illegible or would not fit — a collapsed sidebar, a favicon,
 * anywhere under about 40px wide.
 *
 * Both are raster rather than inline SVG, unlike the mark they replace. The
 * artwork is the real brand asset rather than something redrawn by hand, and
 * a redrawn approximation of a company's logo is worse than a PNG. They are
 * served from each app's own `public/`, so the path is the same in both.
 *
 * Size them by height and let the width follow — `h-8 w-auto`. `object-contain`
 * and `max-w-full` are baked in so neither can overflow or distort inside a
 * narrow flex column, which is how a logo usually breaks a layout.
 */

interface LogoProps {
  /** Set a height (`h-8`) and leave the width to follow. */
  className?: string;
}

export function SparksLogo({ className }: LogoProps) {
  return (
    <img
      src="/sparks-logo.png"
      alt="SPARKS"
      // Intrinsic size of the asset, so the browser reserves the right box
      // before it loads and the header does not jump.
      width={640}
      height={174}
      className={`w-auto max-w-full object-contain ${className ?? ''}`}
    />
  );
}

export function SparksMark({ className }: LogoProps) {
  return (
    <img
      src="/sparks-mark.png"
      alt="SPARKS"
      width={128}
      height={128}
      className={`w-auto max-w-full object-contain ${className ?? ''}`}
    />
  );
}

/**
 * The attribution line under a customer's own branding.
 *
 * The shell belongs to the customer — their name and their logo — so the
 * product sits underneath it rather than above. Rendered as the lockup rather
 * than the word "SPARKS" so the mark is what people come to recognise.
 *
 * `compact` drops the words and keeps the icon, for a collapsed sidebar where
 * "Powered by" would not fit.
 */
export function PoweredBySparks({
  compact = false,
  className,
}: {
  compact?: boolean;
  className?: string;
}) {
  if (compact) {
    return (
      <div className={`flex justify-center ${className ?? ''}`} title="Powered by SPARKS">
        <SparksMark className="h-4 opacity-70" />
      </div>
    );
  }

  return (
    <div className={`flex items-center gap-1.5 min-w-0 ${className ?? ''}`}>
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground shrink-0">
        Powered by
      </span>
      <SparksLogo className="h-3.5 shrink-0" />
    </div>
  );
}
