/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  transpilePackages: ["@mezairstack/config", "@mezairstack/name-squatting", "@mezairstack/object-store", "@mezairstack/persistence", "@mezairstack/shared"]
};

export default nextConfig;
