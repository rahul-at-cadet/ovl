import { IBM_Plex_Sans, IBM_Plex_Mono } from "next/font/google";
import type { Metadata } from "next";
import "./globals.css";
import { TRPCProvider } from "@/components/providers/trpc-provider";
import { ToastProvider, Toaster } from "@ovl/ui/components/toast";
import { ThemeProvider } from "@/components/providers/theme-provider";

/*
 * IBM Plex Sans + Mono, replacing Inter.
 *
 * Plex was drawn for technical interfaces and instrumentation, and its Mono
 * is a true companion rather than an unrelated fallback — which matters on a
 * screen where almost every value is a number that has to line up in a
 * column: positions, bearings, ROB figures, UTC timestamps. Inter is a fine
 * face but reads as generic product UI; this is a bridge terminal, and the
 * type should say so.
 */
const plexSans = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-plex-sans",
  display: "swap",
});

const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-plex-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Cadetlabs | Vessel Reporting Engine",
  description: "Secure local edge reporting for Cadetlabs vessels",
  icons: {
    icon: "/cadetlabs-logo.png",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${plexSans.variable} ${plexMono.variable} font-sans h-full antialiased`}
      suppressHydrationWarning
    >
      <body className="min-h-full flex flex-col" suppressHydrationWarning>
        <ThemeProvider>
          <ToastProvider>
            <TRPCProvider>{children}</TRPCProvider>
            <Toaster />
          </ToastProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
