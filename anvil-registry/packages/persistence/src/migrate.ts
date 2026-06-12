import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { resolveDatabaseUrl } from "@anvilstack/config";
import * as schema from "./schema.js";

const databaseUrl = resolveDatabaseUrl({
  DATABASE_URL: process.env.DATABASE_URL,
  DATABASE_HOST: process.env.DATABASE_HOST,
  DATABASE_PORT: process.env.DATABASE_PORT ? Number.parseInt(process.env.DATABASE_PORT, 10) : undefined,
  DATABASE_NAME: process.env.DATABASE_NAME,
  DATABASE_USER: process.env.DATABASE_USER,
  DATABASE_PASSWORD: process.env.DATABASE_PASSWORD
});

if (!databaseUrl) {
  throw new Error("DATABASE_URL or DATABASE_HOST, DATABASE_NAME, DATABASE_USER, and DATABASE_PASSWORD are required to run persistence migrations");
}

const currentDir = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = process.env.DRIZZLE_MIGRATIONS_FOLDER ?? resolve(currentDir, "../drizzle");
const maxAttempts = Number.parseInt(process.env.DATABASE_READY_ATTEMPTS ?? "30", 10);
const retryDelayMs = Number.parseInt(process.env.DATABASE_READY_DELAY_MS ?? "1000", 10);
const pool = new pg.Pool({ connectionString: databaseUrl });
const db = drizzle(pool, { schema });

try {
  await waitForDatabase(pool, { maxAttempts, retryDelayMs });
  await migrate(db, { migrationsFolder });
  console.log(`[anvil] Drizzle migrations applied from ${migrationsFolder}`);
} finally {
  await pool.end();
}

async function waitForDatabase(pool: pg.Pool, options: { maxAttempts: number; retryDelayMs: number }) {
  const attempts = Number.isFinite(options.maxAttempts) && options.maxAttempts > 0 ? options.maxAttempts : 30;
  const delayMs = Number.isFinite(options.retryDelayMs) && options.retryDelayMs > 0 ? options.retryDelayMs : 1000;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await pool.query("select 1");
      return;
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      await delay(delayMs);
    }
  }

  throw new Error(`Database did not become ready after ${attempts} attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

function delay(milliseconds: number) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
