import { hashPassword } from "../api/auth.js";
import { pool, withTransaction } from "./pool.js";

export const DEMO_USERS = [
  { email: "student@demo.test", name: "Asha Student", role: "student", password: "Demo-pass-123" },
  { email: "evaluator@demo.test", name: "Ravi Evaluator", role: "evaluator", password: "Demo-pass-123" },
  { email: "admin@demo.test", name: "Priya Admin", role: "admin", password: "Demo-pass-123" },
] as const;

/** The default rubric from the assignment brief. Weights sum to 100. */
export const DEFAULT_RUBRIC = [
  { key: "functionality", name: "Functionality", weight: 25, guidance: "10: all described features work and are verified by tests or a demo; 6: core features work with gaps; 3: major features missing or broken; 0: nothing runs." , description: "Does the project do what it claims? Are features complete and verified?" },
  { key: "code_quality", name: "Code Quality", weight: 20, guidance: "10: clean, consistent, idiomatic, well-named, handles errors; 6: readable with some duplication or inconsistency; 3: hard to follow, little error handling; 0: unreadable.", description: "Readability, structure, naming, error handling, consistency." },
  { key: "architecture", name: "Architecture", weight: 20, guidance: "10: clear layering, sensible data model, separation of concerns, justified technology choices; 6: workable but tangled in places; 3: everything in one file / no data model; 0: no discernible structure.", description: "Design of modules, data model, APIs and how they fit together." },
  { key: "problem_solving", name: "Problem Solving", weight: 15, guidance: "10: hard parts identified and solved thoughtfully with trade-offs discussed; 6: reasonable solutions; 3: naive approaches with obvious issues; 0: problem not addressed.", description: "How well the student decomposed and solved the actual problem." },
  { key: "documentation", name: "Documentation", weight: 10, guidance: "10: README with purpose, setup, usage, architecture, decisions; code comments where needed; 6: setup works but thin; 3: minimal README; 0: none.", description: "README, setup instructions, API docs, inline documentation." },
  { key: "innovation_ai_usage", name: "Innovation / AI Usage", weight: 10, guidance: "10: creative, appropriate use of AI or novel approach with safeguards; 6: standard but sensible; 3: gimmicky or unsafe; 0: absent where expected.", description: "Originality and responsible, effective use of AI tools or models." },
];

export async function seed(): Promise<string> {
  return withTransaction(async (tx) => {
    const ids: Record<string, string> = {};
    for (const u of DEMO_USERS) {
      const r = await tx.query<{ id: string }>(
        `INSERT INTO users (email, name, role, password_hash) VALUES ($1, $2, $3, $4)
         ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
        [u.email, u.name, u.role, hashPassword(u.password)],
      );
      ids[u.role] = r.rows[0]!.id;
    }
    const course = await tx.query<{ id: string }>(
      `INSERT INTO courses (code, title) VALUES ('FSD-101', 'Full Stack Development')
       ON CONFLICT (code) DO UPDATE SET title = EXCLUDED.title RETURNING id`,
    );
    const courseId = course.rows[0]!.id;

    const existing = await tx.query<{ id: string; active_rubric_id: string | null }>(
      `SELECT id, active_rubric_id FROM assignments WHERE course_id = $1 AND title = 'Capstone: Build a Web Application'`,
      [courseId],
    );
    let assignmentId = existing.rows[0]?.id;
    if (!assignmentId) {
      const a = await tx.query<{ id: string }>(
        `INSERT INTO assignments (course_id, title, description, due_at)
         VALUES ($1, 'Capstone: Build a Web Application', 'Build and document a full-stack web application with tests and a README.', now() + interval '30 days')
         RETURNING id`,
        [courseId],
      );
      assignmentId = a.rows[0]!.id;
    }
    if (!existing.rows[0]?.active_rubric_id) {
      const r = await tx.query<{ id: string }>(
        `INSERT INTO rubrics (assignment_id, version, status, created_by, published_at) VALUES ($1, 1, 'published', $2, now()) RETURNING id`,
        [assignmentId, ids.admin],
      );
      for (const [i, c] of DEFAULT_RUBRIC.entries()) {
        await tx.query(
          `INSERT INTO rubric_criteria (rubric_id, key, name, description, guidance, weight, max_score, position) VALUES ($1, $2, $3, $4, $5, $6, 10, $7)`,
          [r.rows[0]!.id, c.key, c.name, c.description, c.guidance, c.weight, i],
        );
      }
      await tx.query(`UPDATE assignments SET active_rubric_id = $2 WHERE id = $1`, [assignmentId, r.rows[0]!.id]);
    }
    return `users=${DEMO_USERS.length}, course=FSD-101, assignment=${assignmentId}`;
  });
}

const isMain = process.argv[1] && /seed\.(ts|js)$/.test(process.argv[1]);
if (isMain) {
  seed()
    .then(async (s) => {
      console.log(s);
      await pool.end();
    })
    .catch(async (e) => {
      console.error(e);
      await pool.end();
      process.exit(1);
    });
}
