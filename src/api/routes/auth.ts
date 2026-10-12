import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "../../db/pool.js";
import { verifyPassword, type Role } from "../auth.js";
import { AppError } from "../errors.js";

const LoginBody = z.object({ email: z.string().email().max(200), password: z.string().min(1).max(200) });

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post("/auth/login", async (req) => {
    const body = LoginBody.parse(req.body);
    const { rows } = await pool.query<{ id: string; email: string; name: string; role: Role; password_hash: string }>(
      `SELECT id, email, name, role, password_hash FROM users WHERE email = $1`,
      [body.email.toLowerCase()],
    );
    const user = rows[0];
    if (!user || !verifyPassword(body.password, user.password_hash)) {
      throw new AppError(401, "invalid_credentials", "email or password is incorrect");
    }
    const token = app.jwt.sign({ sub: user.id, role: user.role, email: user.email });
    return { token, user: { id: user.id, email: user.email, name: user.name, role: user.role } };
  });

  app.get("/me", { preHandler: [app.authenticate] }, async (req) => {
    const { rows } = await pool.query(`SELECT id, email, name, role, created_at FROM users WHERE id = $1`, [req.user.sub]);
    return rows[0] ?? null;
  });
}
