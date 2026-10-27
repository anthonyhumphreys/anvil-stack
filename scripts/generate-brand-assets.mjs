import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
const require = createRequire(
  new URL("../mezair-app/package.json", import.meta.url),
);
const sharp = require("sharp");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const trace = await fs.readFile(
  path.join(root, "branding/mezair-mark.svg"),
  "utf8",
);
const paths = trace.match(/<path\b[^>]*\/>/g);
if (paths?.length !== 3) throw new Error("Expected three approved mark shapes");
const geometry = paths
  .join("\n")
  .replaceAll('fill="#000000"', 'fill="currentColor"');
const viewBox = "160 160 1216 800";
const mark = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}"><title>Mezair</title>\n${geometry}\n</svg>\n`;

function icon({ rounded = false, dark = false, background = true } = {}) {
  const ink = dark ? "#f8f7f4" : "#171717";
  const paper = dark ? "#171717" : "#f8f7f4";
  const backdrop = !background
    ? ""
    : rounded
      ? `<rect x="64" y="64" width="896" height="896" rx="198" fill="${paper}"/>`
      : `<rect width="1024" height="1024" fill="${paper}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">${backdrop}<svg x="192" y="301" width="640" height="422" viewBox="${viewBox}" style="color:${ink}">${geometry}</svg></svg>`;
}
async function png(relative, source, size = 1024) {
  const target = path.join(root, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await sharp(Buffer.from(source)).resize(size, size).png().toFile(target);
}
await fs.writeFile(
  path.join(root, "branding/mezair-icon.svg"),
  icon({ rounded: true }),
);
await png("mezair-app/resources/mezair.png", icon({ rounded: true }));
for (const size of [16, 32, 128, 256, 512]) {
  await png(
    `mezair-app/resources/mezair.iconset/icon_${size}x${size}.png`,
    icon({ rounded: true }),
    size,
  );
  await png(
    `mezair-app/resources/mezair.iconset/icon_${size}x${size}@2x.png`,
    icon({ rounded: true }),
    size * 2,
  );
}
await png("mezair-app/mobile/assets/images/icon.png", icon());
await png(
  "mezair-app/mobile/assets/images/android-icon-foreground.png",
  icon({ background: false }),
);
await png(
  "mezair-app/mobile/assets/images/android-icon-monochrome.png",
  icon({ background: false }),
);
await png(
  "mezair-app/mobile/assets/images/android-icon-background.png",
  '<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><rect width="1024" height="1024" fill="#f8f7f4"/></svg>',
);
await png("mezair-app/mobile/assets/images/favicon.png", icon(), 64);
await png(
  "mezair-app/mobile/assets/images/splash-icon.png",
  icon({ background: false, dark: true }),
);
await png(
  "mezair-app/raycast/mezair/assets/command-icon.png",
  icon({ rounded: true }),
  512,
);
await png("branding/mezair-icon-preview.png", icon({ rounded: true }), 512);
console.log(
  "Created canonical three-shape SVG, identity reference, desktop iconset, mobile icons and Raycast icon.",
);

await fs.mkdir(path.join(root, "mezair-app/video/public"), { recursive: true });
await fs.writeFile(
  path.join(root, "mezair-app/video/public/mezair-mark.svg"),
  mark,
);
await fs.writeFile(
  path.join(root, "mezair-app/src/renderer/assets/mezair-mark.svg"),
  mark,
);
if (process.platform === "darwin") {
  execFileSync(
    "iconutil",
    [
      "-c",
      "icns",
      path.join(root, "mezair-app/resources/mezair.iconset"),
      "-o",
      path.join(root, "mezair-app/resources/mezair.icns"),
    ],
    { stdio: "inherit" },
  );
}
