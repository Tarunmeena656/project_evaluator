import fastifyMultipart from "@fastify/multipart";
import Fastify, { type FastifyBaseLogger } from "fastify";
import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { closePool, pool } from "../db/pool.js";
import { logger } from "../logger.js";
import { PgQueue } from "../queue/pg-queue.js";
import type { JobQueue } from "../queue/types.js";
import { registerAuth } from "./auth.js";
import { errorHandler } from "./errors.js";
import { assignmentRoutes } from "./routes/assignments.js";
import { authRoutes } from "./routes/auth.js";
import { evaluationRoutes } from "./routes/evaluations.js";
import { miscRoutes } from "./routes/misc.js";
import { submissionRoutes } from "./routes/submissions.js";

export async function buildApp(queue: JobQueue = new PgQueue(pool)) {
  const app = Fastify({
    loggerInstance: logger.child({ component: "api" }) as unknown as FastifyBaseLogger,
    genReqId: (req) => (req.headers["x-request-id"] as string | undefined) ?? randomUUID(),
    bodyLimit: 1024 * 1024, // JSON bodies; file uploads go through multipart with their own limit
    trustProxy: true,
  });

  app.setErrorHandler(errorHandler);
  await registerAuth(app);
  await app.register(fastifyMultipart, {
    limits: { fileSize: config.MAX_UPLOAD_BYTES, files: 1, fields: 5 },
    throwFileSizeLimit: false, // we check `truncated` ourselves to return a clean 413
  });

  app.addHook("onSend", async (_req, reply) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("cache-control", "no-store");
  });

  await app.register(authRoutes);
  await app.register(assignmentRoutes);
  await app.register(submissionRoutes);
  await app.register(async (instance) => evaluationRoutes(instance, queue));
  await app.register(async (instance) => miscRoutes(instance, queue));
  return app;
}

const isMain = process.argv[1] && /api[\\/]server\.(ts|js)$/.test(process.argv[1]);
if (isMain) {
  buildApp()
    .then(async (app) => {
      await app.listen({ port: config.PORT, host: "0.0.0.0" });
      const shutdown = async (signal: string) => {
        app.log.info({ signal }, "api stopping");
        await app.close();
        await closePool();
        process.exit(0);
      };
      process.on("SIGTERM", () => void shutdown("SIGTERM"));
      process.on("SIGINT", () => void shutdown("SIGINT"));
    })
    .catch((err) => {
      logger.error({ err }, "api failed to start");
      process.exit(1);
    });
}
