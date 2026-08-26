import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

/*
 * This package defines no colours of its own — components style themselves
 * through the theme tokens each app declares in its globals.css. That is what
 * lets one <StatusBadge> render brand teal in the office app and a
 * low-saturation S-52 tan on a darkened bridge. A raw palette class here would
 * look correct in one app and be actively unsafe in the other, so the same
 * rule both apps enforce applies to the shared source too.
 */
const PALETTE_CLASS =
  "(?:^|\\s)(?:(?:hover|focus|focus-visible|focus-within|active|disabled|group-hover|dark|sm|md|lg|xl):)*" +
  "(?:bg|text|border|ring|outline|divide|from|via|to|fill|stroke|shadow|accent|caret|decoration)-" +
  "(?:red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone)-" +
  "[0-9]{2,3}(?:[/][0-9]{1,3})?(?:$|\\s)";

const MESSAGE =
  "Raw Tailwind palette class. @ovl/ui must not define colour — use a theme token (text-foreground, bg-card, border-border) or the semantic status scale (text-status-ok/-warn/-attention/-critical/-info).";

export default defineConfig([
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      "no-restricted-syntax": [
        "error",
        { selector: `Literal[value=/${PALETTE_CLASS}/]`, message: MESSAGE },
        { selector: `TemplateElement[value.raw=/${PALETTE_CLASS}/]`, message: MESSAGE },
      ],
    },
  },
]);
