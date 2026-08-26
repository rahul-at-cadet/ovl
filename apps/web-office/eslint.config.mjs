import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

/*
 * Raw Tailwind palette classes are banned in components.
 *
 * globals.css is the single source of truth for colour in this app, and a
 * literal like `text-emerald-400` bypasses it completely — it can't follow
 * the light/dark palettes, and it can't follow the semantic --status-* scale.
 * Before this rule there were 407 of them across 29 files, which is how the
 * same report state ended up rendering in three different colours on three
 * different screens.
 *
 * Use a token instead: text-foreground / text-muted-foreground / bg-card /
 * border-border for chrome, and text-status-ok | -warn | -attention |
 * -critical | -info (with /10 fills and /25 borders) for state. Prefer the
 * <StatusBadge> component over hand-rolling a status chip at all.
 */
const PALETTE_CLASS =
  "(?:^|\\s)(?:(?:hover|focus|focus-visible|focus-within|active|disabled|group-hover|dark|sm|md|lg|xl):)*" +
  "(?:bg|text|border|ring|outline|divide|from|via|to|fill|stroke|shadow|accent|caret|decoration)-" +
  "(?:red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone)-" +
  "[0-9]{2,3}(?:[/][0-9]{1,3})?(?:$|\\s)";

const NO_RAW_PALETTE = [
  "error",
  {
    selector: `Literal[value=/${PALETTE_CLASS}/]`,
    message:
      "Raw Tailwind palette class. Colour lives in globals.css — use a theme token (text-foreground, bg-card, border-border) or the semantic status scale (text-status-ok/-warn/-attention/-critical/-info), or reach for <StatusBadge>.",
  },
  {
    selector: `TemplateElement[value.raw=/${PALETTE_CLASS}/]`,
    message:
      "Raw Tailwind palette class. Colour lives in globals.css — use a theme token (text-foreground, bg-card, border-border) or the semantic status scale (text-status-ok/-warn/-attention/-critical/-info), or reach for <StatusBadge>.",
  },
];

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    files: ["src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": NO_RAW_PALETTE,
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
