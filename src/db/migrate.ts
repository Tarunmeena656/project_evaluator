/**
 * Minimal forward-only SQL migration runner.
 *   npm run migrate            -> apply pending db/migrations/*.sql
 *   npm run migrate -- --seed  -> also seed demo data
 *
 * Each migration runs in its own transaction, guarded by an advisory lock so
 * that api/worker containers booting together do not race.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pool, closePool } from "./pool.js";
import { seed } from "./seed.js";

const MIGRATIONS_DIR = path.resolve(process.cwd(), "db", "migrations");
const LOCK_KEY = 72_001; // arbitrary app-wide advisory lock id

export async function migrate(): Promise<string[]> {
  const applied: string[] = [];
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
    const done = new Set(
      (await client.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map((r) => r.name),
    );
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations(name) VALUES ($1)", [file]);
        await client.query("COMMIT");
        applied.push(file);
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`migration ${file} failed: ${(err as Error).message}`);
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => undefined);
    client.release();
  }
  return applied;
}

const isMain = process.argv[1] && /migrate\.(ts|js)$/.test(process.argv[1]);
if (isMain) {
  migrate()
    .then(async (applied) => {
      console.log(applied.length ? `applied: ${applied.join(", ")}` : "no pending migrations");
      if (process.argv.includes("--seed")) {
        const summary = await seed();
        console.log(`seeded: ${summary}`);
      }
      await closePool();
    })
    .catch(async (err) => {
      console.error(err);
      await closePool();
      process.exit(1);
    });
}
