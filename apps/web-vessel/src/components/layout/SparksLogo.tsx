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
