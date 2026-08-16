import { Inter } from "next/font/google";
import type { Metadata } from "next";
import "./globals.css";
import { TRPCProvider } from "@/components/providers/trpc-provider";
import { SuperTokensProvider } from "@/components/providers/supertokens-provider";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
});

export const metadata: Metadata = {
  title: "OVL Command | Office Dashboard",
  description: "Centralized fleet management and reporting",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${inter.variable} font-sans h-full antialiased dark`}
    >
      <body className="min-h-full flex flex-col">
        <SuperTokensProvider>
          <TRPCProvider>{children}</TRPCProvider>
        </SuperTokensProvider>
      </body>
    </html>
  );
}
