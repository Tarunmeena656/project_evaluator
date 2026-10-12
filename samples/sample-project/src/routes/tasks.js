import { sendJson } from "../index.js";
import { createTask, deleteTask, getTask, listTasks, updateTask } from "../services/taskService.js";

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export async function handleTasks(req, res, url) {
  const id = url.pathname.split("/")[2];

  if (req.method === "GET" && !id) return sendJson(res, 200, listTasks(url.searchParams.get("status")));
  if (req.method === "POST" && !id) {
    const body = await readBody(req);
    const result = createTask(body);
    return sendJson(res, result.ok ? 201 : 400, result.ok ? result.task : { error: result.error });
  }
  if (!id) return sendJson(res, 405, { error: "method not allowed" });

  const task = getTask(Number(id));
  if (!task) return sendJson(res, 404, { error: "task not found" });

  if (req.method === "GET") return sendJson(res, 200, task);
  if (req.method === "PATCH") {
    const result = updateTask(task.id, await readBody(req));
    return sendJson(res, result.ok ? 200 : 400, result.ok ? result.task : { error: result.error });
  }
  if (req.method === "DELETE") {
    deleteTask(task.id);
    return sendJson(res, 204, {});
  }
  return sendJson(res, 405, { error: "method not allowed" });
}
