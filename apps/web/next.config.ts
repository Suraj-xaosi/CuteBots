import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  transpilePackages: ["@workspace/core", "@workspace/db", "@workspace/types", "@workspace/ui"],
}

export default nextConfig
