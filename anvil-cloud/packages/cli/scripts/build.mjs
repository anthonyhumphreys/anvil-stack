import { cp, mkdir, rm } from "node:fs/promises";

import { build } from "esbuild";

await rm("dist", { recursive: true, force: true });

await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  external: [
    "@aws-sdk/*",
    "@pulumi/*",
    "esbuild",
    "jose",
    "typescript",
    "vite",
  ],
  banner: {
    js: [
      "import { createRequire as __anvilCreateRequire } from 'node:module';",
      "import { fileURLToPath as __anvilFileURLToPath } from 'node:url';",
      "import { dirname as __anvilDirname } from 'node:path';",
      "const require = __anvilCreateRequire(import.meta.url);",
      "const __filename = __anvilFileURLToPath(import.meta.url);",
      "const __dirname = __anvilDirname(__filename);",
    ].join(" "),
  },
});

await Promise.all([
  cp("../auth/src", "dist/packages/auth/src", { recursive: true }),
  cp("../aws/src", "dist/packages/aws/src", { recursive: true }),
  cp("../cloudflare/src", "dist/packages/cloudflare/src", { recursive: true }),
  cp("../deployment/src", "dist/packages/deployment/src", { recursive: true }),
  cp("../runtime/src", "dist/packages/runtime/src", { recursive: true }),
  cp("../client/src", "dist/packages/client/src", { recursive: true }),
]);

await rm("docs", { recursive: true, force: true });
await mkdir("docs", { recursive: true });
await Promise.all([
  cp("../../llms.txt", "docs/llms.txt"),
  cp("../../llms-full.txt", "docs/llms-full.txt"),
]);
