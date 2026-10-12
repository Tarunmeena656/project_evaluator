import { db } from "../db/client.js";

const STATUSES = ["todo", "doing", "done"];
const ALLOWED_TRANSITIONS = { todo: ["doing", "done"], doing: ["todo", "done"], done: ["todo"] };

export function validateTask(input, partial = false) {
  if (!partial || input.title !== undefined) {
    if (typeof input.title !== "string" || input.title.trim().length < 1 || input.title.length > 200) {
      return "title must be 1-200 characters";
    }
  }
  if (input.description !== undefined && typeof input.description !== "string") return "description must be a string";
  if (input.due_date !== undefined && Number.isNaN(Date.parse(input.due_date))) return "due_date must be an ISO date";
  if (input.status !== undefined && !STATUSES.includes(input.status)) return `status must be one of ${STATUSES.join(", ")}`;
  return null;
}

export function listTasks(status) {
  if (status) return db.prepare("SELECT * FROM tasks WHERE status = ? ORDER BY due_date").all(status);
  return db.prepare("SELECT * FROM tasks ORDER BY created_at DESC").all();
}

export function getTask(id) {
  return db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
}

export function createTask(input) {
  const error = validateTask(input);
  if (error) return { ok: false, error };
  const info = db
    .prepare("INSERT INTO tasks (title, description, due_date, status) VALUES (?, ?, ?, 'todo')")
    .run(input.title.trim(), input.description ?? null, input.due_date ?? null);
  return { ok: true, task: getTask(info.lastInsertRowid) };
}

export function updateTask(id, input) {
  const error = validateTask(input, true);
  if (error) return { ok: false, error };
  const current = getTask(id);
  if (input.status && input.status !== current.status && !ALLOWED_TRANSITIONS[current.status].includes(input.status)) {
    return { ok: false, error: `cannot move from ${current.status} to ${input.status}` };
  }
  const next = { ...current, ...input };
  db.prepare("UPDATE tasks SET title = ?, description = ?, due_date = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
    .run(next.title, next.description, next.due_date, next.status, id);
  return { ok: true, task: getTask(id) };
}

export function deleteTask(id) {
  db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
}
