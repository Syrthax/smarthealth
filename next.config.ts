import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The parent directory holds unrelated projects; keep Turbopack scoped to this app.
  turbopack: { root: __dirname },
};

export default nextConfig;
