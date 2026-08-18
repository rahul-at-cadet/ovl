import { Inter } from "next/font/google";
import type { Metadata } from "next";
import "./globals.css";
import { TRPCProvider } from "@/components/providers/trpc-provider";
import { SuperTokensProvider } from "@/components/providers/supertokens-provider";
import { ThemeProvider } from "@/components/providers/theme-provider";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
});

export const metadata: Metadata = {
  title: "Cadetlabs | Office Dashboard",
  description: "Centralized fleet management and reporting",
  icons: {
    icon: "/cadetlabs-logo.png",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${inter.variable} font-sans h-full antialiased`}
      suppressHydrationWarning
    >
      <body className="min-h-full flex flex-col" suppressHydrationWarning>
        <ThemeProvider>
          <SuperTokensProvider>
            <TRPCProvider>{children}</TRPCProvider>
          </SuperTokensProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
