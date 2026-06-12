/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  transpilePackages: ["@anvilstack/config", "@anvilstack/name-squatting", "@anvilstack/object-store", "@anvilstack/persistence", "@anvilstack/shared"]
};

export default nextConfig;
