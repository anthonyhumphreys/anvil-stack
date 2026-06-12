import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  outputFileTracingRoot: projectRoot,
  reactStrictMode: true,
  async redirects() {
    const registryDocs = [
      "alpha-status",
      "api-reference",
      "architecture",
      "ci",
      "cli",
      "deploy",
      "introduction",
      "llm-integration",
      "package-decisions",
      "policy",
      "quickstart",
      "registry-configuration",
      "registry-seeding",
      "registry",
      "troubleshooting"
    ];

    return [
      ...registryDocs.map((slug) => ({
        source: `/docs/${slug}`,
        destination: `/docs/registry/${slug}`,
        permanent: false
      })),
      {
        source: "/docs/node-base",
        destination: "/docs/node-base/overview",
        permanent: false
      },
      {
        source: "/docs/node-base-observed-mode",
        destination: "/docs/node-base/observed-mode",
        permanent: false
      },
      {
        source: "/docs/node-base-reports",
        destination: "/docs/node-base/reports",
        permanent: false
      },
      {
        source: "/docs/node-base-safe-mode",
        destination: "/docs/node-base/safe-mode",
        permanent: false
      }
    ];
  }
};

export default nextConfig;
