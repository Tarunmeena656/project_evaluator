import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DB_PATH = ":memory:";
const { migrate } = await import("../src/db/client.js");
const { createTask, updateTask, listTasks, validateTask } = await import("../src/services/taskService.js");

migrate();

test("rejects an empty title", () => {
  assert.equal(validateTask({ title: "" }), "title must be 1-200 characters");
});

test("creates and lists a task", () => {
  const r = createTask({ title: "Write README" });
  assert.equal(r.ok, true);
  assert.equal(r.task.status, "todo");
  assert.ok(listTasks().some((t) => t.id === r.task.id));
});

test("enforces status transitions", () => {
  const { task } = createTask({ title: "Ship it" });
  const done = updateTask(task.id, { status: "done" });
  assert.equal(done.ok, true);
  const back = updateTask(task.id, { status: "doing" });
  assert.equal(back.ok, false);
  assert.match(back.error, /cannot move/);
});
