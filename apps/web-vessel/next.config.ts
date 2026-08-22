import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  // Standalone output traces only the dependencies this app actually
  // uses into .next/standalone (a self-contained server.js + minimal
  // node_modules), instead of shipping the whole monorepo node_modules
  // into the production image. outputFileTracingRoot points tracing at
  // the monorepo root so workspace packages (@ovl/vessel-database etc.)
  // under the root node_modules resolve correctly.
  output: "standalone",
  outputFileTracingRoot: path.join(__dirname, "../../"),
};

export default nextConfig;
