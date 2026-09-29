import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: ['127.0.0.1', 'localhost', '127.0.0.1:8000', 'localhost:8000'],
};

export default nextConfig;
