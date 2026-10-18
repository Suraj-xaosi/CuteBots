import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  transpilePackages: ["@workspace/ui"],
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${process.env.AGENT_API_URL ?? "http://localhost:3001"}/api/:path*`,
      },
    ]
  },
}

export default nextConfig
