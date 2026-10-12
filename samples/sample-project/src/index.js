import http from "node:http";
import { handleTasks } from "./routes/tasks.js";

const PORT = process.env.PORT ?? 3000;

export function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    try {
      if (url.pathname === "/tasks" || url.pathname.startsWith("/tasks/")) {
        return await handleTasks(req, res, url);
      }
      sendJson(res, 404, { error: "not found" });
    } catch (err) {
      console.error(err);
      sendJson(res, 500, { error: "internal error" });
    }
  });
}

export function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

if (process.argv[1]?.endsWith("index.js")) {
  createServer().listen(PORT, () => console.log(`listening on ${PORT}`));
}
