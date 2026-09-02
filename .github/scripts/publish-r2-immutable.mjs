import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

export async function publishR2ImmutableObject(options, dependencies = {}) {
  const runAws = dependencies.runAws ?? runAwsCli;
  const hashFile = dependencies.hashFile ?? sha256File;
  const sha256 = await hashFile(options.file);
  const commonArgs = [
    "--endpoint-url",
    options.endpoint,
    "--region",
    "auto",
    "--no-cli-pager",
  ];
  const putResult = await runAws([
    "s3api",
    "put-object",
    "--bucket",
    options.bucket,
    "--key",
    options.key,
    "--body",
    options.file,
    "--content-type",
    options.contentType,
    "--content-disposition",
    options.contentDisposition,
    "--cache-control",
    options.cacheControl,
    "--metadata",
    `sha256=${sha256}`,
    "--if-none-match",
    "*",
    ...commonArgs,
  ]);
  if (putResult.code === 0) return "created";

  const headResult = await runAws([
    "s3api",
    "head-object",
    "--bucket",
    options.bucket,
    "--key",
    options.key,
    "--query",
    "Metadata.sha256",
    "--output",
    "text",
    ...commonArgs,
  ]);
  if (headResult.code === 0 && headResult.stdout.trim() === sha256)
    return "unchanged";

  const detail =
    headResult.stderr.trim() || putResult.stderr.trim() || "unknown R2 error";
  throw new Error(
    `Refusing to replace immutable R2 object ${options.bucket}/${options.key}: ${detail}`,
  );
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function runAwsCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("aws", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stderr, stdout }));
  });
}

function parseOptions(args) {
  const [
    accountId,
    bucket,
    key,
    file,
    contentType,
    contentDisposition,
    cacheControl,
  ] = args;
  if (!/^[a-f0-9]{32}$/i.test(accountId ?? "")) {
    throw new Error("Cloudflare account ID must be 32 hexadecimal characters.");
  }
  if (
    ![bucket, key, file, contentType, contentDisposition, cacheControl].every(
      Boolean,
    )
  ) {
    throw new Error(
      "Expected account ID, bucket, key, file, content type, content disposition, and cache control.",
    );
  }
  return {
    bucket,
    cacheControl,
    contentDisposition,
    contentType,
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    file,
    key,
  };
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const result = await publishR2ImmutableObject(options);
  console.log(`${result}: ${options.bucket}/${options.key}`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
