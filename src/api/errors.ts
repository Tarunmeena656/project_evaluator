import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";

export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const notFound = (what: string) => new AppError(404, "not_found", `${what} not found`);
export const forbidden = (msg = "you do not have access to this resource") => new AppError(403, "forbidden", msg);
export const badRequest = (msg: string, details?: unknown) => new AppError(400, "bad_request", msg, details);
export const conflict = (code: string, msg: string, details?: unknown) => new AppError(409, code, msg, details);

interface PgError extends Error {
  code?: string;
  constraint?: string;
}

export function errorHandler(err: FastifyError | Error, req: FastifyRequest, reply: FastifyReply): void {
  if (err instanceof AppError) {
    void reply.status(err.status).send({ error: { code: err.code, message: err.message, details: err.details } });
    return;
  }
  if (err instanceof ZodError) {
    void reply.status(400).send({
      error: { code: "validation_error", message: "request validation failed", details: err.issues },
    });
    return;
  }
  const pg = err as PgError;
  if (pg.code === "23505") {
    void reply.status(409).send({ error: { code: "conflict", message: `duplicate: ${pg.constraint ?? "unique constraint"}` } });
    return;
  }
  if (pg.code === "22P02") {
    void reply.status(400).send({ error: { code: "bad_request", message: "malformed identifier" } });
    return;
  }
  const f = err as FastifyError;
  if (typeof f.statusCode === "number" && f.statusCode < 500) {
    void reply.status(f.statusCode).send({ error: { code: f.code ?? "request_error", message: f.message } });
    return;
  }
  req.log.error({ err }, "unhandled error");
  void reply.status(500).send({ error: { code: "internal_error", message: "internal server error", request_id: req.id } });
}
