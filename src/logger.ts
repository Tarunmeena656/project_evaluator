import pino from "pino";
import { config } from "./config.js";

export const logger = pino({
  level: config.LOG_LEVEL,
  // Never log secrets or raw student content.
  redact: {
    paths: ["req.headers.authorization", "*.password", "*.apiKey", "*.ANTHROPIC_API_KEY"],
    censor: "[redacted]",
  },
  base: { service: process.env.SERVICE_NAME ?? "project-evaluator" },
});

export type Logger = typeof logger;
