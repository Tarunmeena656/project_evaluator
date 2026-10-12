import Database from "better-sqlite3";
import { readFileSync } from "node:fs";

export const db = new Database(process.env.DB_PATH ?? "tasks.sqlite");
db.pragma("journal_mode = WAL");

export function migrate() {
  db.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
}
