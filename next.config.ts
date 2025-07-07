import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  env: {
    N8N_WEBHOOK_URL: process.env.N8N_WEBHOOK_URL,
    BACKEND_URL: process.env.BACKEND_URL,
  },
};

export default nextConfig;
