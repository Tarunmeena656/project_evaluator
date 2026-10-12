import { lstat, open, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { LIMITS } from "../config.js";

export type FileKind = "code" | "test" | "config" | "docs" | "schema" | "asset" | "data" | "lock" | "binary" | "document" | "other";

export interface FileEntry {
  path: string; // posix, relative to root
  sizeBytes: number;
  kind: FileKind;
  language: string | null;
  lines: number | null;
  priority: number; // higher = more worth the LLM's attention
  skipReason?: string;
}

export interface Signals {
  fileCount: number;
  codeFileCount: number;
  testFileCount: number;
  totalLines: number;
  hasTests: boolean;
  hasReadme: boolean;
  readmeChars: number;
  readmeFirstLine: string;
  hasCi: boolean;
  hasDocker: boolean;
  hasSchema: boolean;
  hasSecretPattern: boolean;
  secretPaths: string[];
  mentionsAi: boolean;
  entryPoints: string[];
  routeFiles: string[];
  promptInjectionSuspected: boolean;
  injectionPaths: string[];
}

export interface Inventory {
  root: string;
  files: FileEntry[];
  languages: Record<string, number>; // language -> line count
  dirCount: number;
  totalBytes: number;
  signals: Signals;
}

const IGNORED_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", ".next", ".nuxt", "venv", ".venv", "env", "__pycache__",
  "target", "vendor", "coverage", ".idea", ".vscode", ".cache", ".turbo", ".parcel-cache", "bin", "obj", ".gradle",
]);

const LANG_BY_EXT: Record<string, string> = {
  ".ts": "TypeScript", ".tsx": "TypeScript", ".js": "JavaScript", ".jsx": "JavaScript", ".mjs": "JavaScript", ".cjs": "JavaScript",
  ".py": "Python", ".java": "Java", ".kt": "Kotlin", ".go": "Go", ".rs": "Rust", ".rb": "Ruby", ".php": "PHP",
  ".cs": "C#", ".cpp": "C++", ".cc": "C++", ".c": "C", ".h": "C/C++ header", ".swift": "Swift", ".dart": "Dart",
  ".scala": "Scala", ".sql": "SQL", ".sh": "Shell", ".html": "HTML", ".css": "CSS", ".scss": "SCSS", ".vue": "Vue", ".svelte": "Svelte",
  ".ipynb": "Jupyter",
};
const DOC_EXT = new Set([".md", ".mdx", ".rst", ".txt", ".adoc"]);
const CONFIG_EXT = new Set([".json", ".yaml", ".yml", ".toml", ".ini", ".env.example", ".cfg", ".xml", ".properties"]);
const DATA_EXT = new Set([".csv", ".tsv", ".parquet", ".jsonl", ".db", ".sqlite", ".sqlite3"]);
const BINARY_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".svg", ".pdf", ".zip", ".gz", ".tar", ".jar", ".war", ".exe", ".dll", ".so",
  ".dylib", ".class", ".pyc", ".woff", ".woff2", ".ttf", ".eot", ".mp4", ".mov", ".mp3", ".wav", ".bin", ".pkl", ".h5", ".onnx", ".pt",
]);
const LOCK_FILES = new Set(["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "poetry.lock", "Pipfile.lock", "Cargo.lock", "go.sum", "composer.lock", "Gemfile.lock"]);
const MANIFESTS = new Set(["package.json", "pyproject.toml", "requirements.txt", "pom.xml", "build.gradle", "go.mod", "Cargo.toml", "Gemfile", "composer.json", "setup.py", "Pipfile"]);

const SECRET_RE = /(?:api[_-]?key|secret|password|passwd|token)\s*[:=]\s*['"][A-Za-z0-9_\-/+=]{16,}['"]|AKIA[0-9A-Z]{16}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|sk-[A-Za-z0-9]{20,}/;
const INJECTION_RE =
  /ignore (?:all |any )?(?:previous|prior|above|earlier) instructions|disregard (?:the|your) (?:rubric|instructions)|you are (?:now )?(?:an? |the )?(?:ai )?(?:evaluator|grader|assessor)|(?:give|award|assign) (?:this|me|the project|it) (?:a )?(?:full|maximum|perfect|top) (?:score|marks|grade)|score(?:d)? (?:this )?(?:10|100)\s*(?:\/|out of)\s*(?:10|100)|<\/?system>|\bsystem prompt\b/i;
const AI_RE = /\b(openai|anthropic|claude|gpt-?[0-9]|langchain|llamaindex|llm|hugging ?face|transformers|gemini|mistral|ollama|embedding|vector (?:db|database|store)|rag)\b/i;

/**
 * Walk the extracted project, classify every file, compute deterministic
 * signals, and rank files by how much they deserve LLM attention. Pure file
 * system work: no code is executed.
 */
export async function buildInventory(root: string): Promise<Inventory> {
  const files: FileEntry[] = [];
  const languages: Record<string, number> = {};
  let dirCount = 0;
  let totalBytes = 0;
  const signals: Signals = {
    fileCount: 0, codeFileCount: 0, testFileCount: 0, totalLines: 0,
    hasTests: false, hasReadme: false, readmeChars: 0, readmeFirstLine: "", hasCi: false, hasDocker: false, hasSchema: false,
    hasSecretPattern: false, secretPaths: [], mentionsAi: false, entryPoints: [], routeFiles: [],
    promptInjectionSuspected: false, injectionPaths: [],
  };

  const walk = async (dir: string, rel: string): Promise<void> => {
    const names = await readdir(dir);
    for (const name of names.sort()) {
      const abs = path.join(dir, name);
      const relPath = rel ? `${rel}/${name}` : name;
      const st = await lstat(abs);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        if (IGNORED_DIRS.has(name)) continue;
        if (relPath === ".github" || relPath.startsWith(".github/")) signals.hasCi = true;
        dirCount += 1;
        await walk(abs, relPath);
        continue;
      }
      if (!st.isFile()) continue;
      totalBytes += st.size;
      const entry = await classify(abs, relPath, st.size);
      files.push(entry);
    }
  };
  await walk(root, "");

  for (const f of files) {
    signals.fileCount += 1;
    if (f.kind === "code") signals.codeFileCount += 1;
    if (f.kind === "test") {
      signals.testFileCount += 1;
      signals.hasTests = true;
    }
    if (f.lines && f.language) languages[f.language] = (languages[f.language] ?? 0) + f.lines;
    if (f.lines) signals.totalLines += f.lines;
    const base = path.posix.basename(f.path).toLowerCase();
    if (/^readme(\.|$)/.test(base) && f.path.split("/").length <= 2) signals.hasReadme = true;
    if (base === "dockerfile" || base === "docker-compose.yml" || base === "docker-compose.yaml") signals.hasDocker = true;
    if (/\.(gitlab-ci\.yml|travis\.yml|circleci)/.test(f.path) || f.path.startsWith(".github/workflows/")) signals.hasCi = true;
    if (f.kind === "schema") signals.hasSchema = true;
    if (/(^|\/)(index|main|app|server|manage|cli)\.(ts|js|py|go|rs|java|kt|rb|php|cs)$/.test(f.path)) signals.entryPoints.push(f.path);
    if (/(route|router|controller|handler|endpoint|api|views)/i.test(f.path) && f.kind === "code") signals.routeFiles.push(f.path);
  }

  // Content-derived signals from a bounded set of text files.
  const textFiles = files
    .filter((f) => ["code", "test", "docs", "config", "schema"].includes(f.kind) && !f.skipReason)
    .sort((a, b) => b.priority - a.priority)
    .slice(0, 400);
  for (const f of textFiles) {
    const content = await readFile(path.join(root, ...f.path.split("/")), "utf8").catch(() => "");
    if (!content) continue;
    const base = path.posix.basename(f.path).toLowerCase();
    if (/^readme(\.|$)/.test(base) && f.path.split("/").length <= 2) {
      signals.readmeChars = Math.max(signals.readmeChars, content.length);
      signals.readmeFirstLine ||= content.split("\n").find((l) => l.trim() && !l.startsWith("#"))?.trim().slice(0, 200) ?? "";
    }
    if (f.kind !== "docs" && SECRET_RE.test(content)) {
      signals.hasSecretPattern = true;
      signals.secretPaths.push(f.path);
    }
    if (INJECTION_RE.test(content)) {
      signals.promptInjectionSuspected = true;
      signals.injectionPaths.push(f.path);
    }
    if (!signals.mentionsAi && (MANIFESTS.has(base) || f.kind === "docs") && AI_RE.test(content)) signals.mentionsAi = true;
  }

  return { root, files, languages, dirCount, totalBytes, signals };
}

async function classify(abs: string, relPath: string, size: number): Promise<FileEntry> {
  const base = path.posix.basename(relPath);
  const ext = path.posix.extname(base).toLowerCase();
  const lower = relPath.toLowerCase();
  let kind: FileKind = "other";
  let language: string | null = LANG_BY_EXT[ext] ?? null;

  if (LOCK_FILES.has(base)) kind = "lock";
  else if (BINARY_EXT.has(ext)) kind = ext === ".pdf" ? "document" : "binary";
  else if (DATA_EXT.has(ext)) kind = "data";
  else if (ext === ".sql" || /(migration|schema|prisma|\.prisma$|models?\.py$|entities?)/.test(lower)) kind = "schema";
  else if (language && /(^|\/)(tests?|__tests__|spec|e2e)\//.test(lower) || /\.(test|spec)\.[a-z]+$/.test(lower) || /^test_.*\.py$/.test(base)) kind = "test";
  else if (language) kind = "code";
  else if (DOC_EXT.has(ext) || /^(readme|license|changelog|contributing)/i.test(base)) kind = "docs";
  else if (CONFIG_EXT.has(ext) || MANIFESTS.has(base) || /^(dockerfile|makefile|procfile|\.env\.example)$/i.test(base) || base.startsWith(".")) kind = "config";
  else if (size > 0 && (await looksBinary(abs))) kind = "binary";

  if (kind === "schema" && !language) language = "SQL";

  let lines: number | null = null;
  let skipReason: string | undefined;
  if (["code", "test", "docs", "config", "schema"].includes(kind)) {
    if (size > LIMITS.maxAnalysedFileBytes) skipReason = `larger than ${LIMITS.maxAnalysedFileBytes} bytes`;
    else lines = await countLines(abs);
  } else if (kind === "lock") skipReason = "lock file";
  else if (kind === "binary") skipReason = "binary";
  else if (kind === "data") skipReason = "data file";

  return { path: relPath, sizeBytes: size, kind, language, lines, priority: priorityOf(relPath, kind, lines ?? 0), skipReason };
}

function priorityOf(relPath: string, kind: FileKind, lines: number): number {
  const base = path.posix.basename(relPath).toLowerCase();
  const depth = relPath.split("/").length;
  if (/^readme/.test(base) && depth === 1) return 100;
  if (MANIFESTS.has(path.posix.basename(relPath))) return 90;
  if (/(^|\/)(index|main|app|server)\.[a-z]+$/.test(relPath) && kind === "code") return 85 - depth;
  if (kind === "schema") return 80 - depth;
  if (/(route|router|controller|handler|service|api)/i.test(relPath) && kind === "code") return 75 - depth;
  if (kind === "test") return 60 - depth;
  if (kind === "docs") return 55 - depth;
  if (kind === "code") {
    // prefer substantial-but-readable files; tiny and gigantic files score lower
    const sizeScore = lines < 15 ? -15 : lines > 1500 ? -10 : lines > 80 ? 5 : 0;
    return 50 - depth + sizeScore;
  }
  if (kind === "config") return base === "dockerfile" || base.endsWith(".yml") ? 35 : 25;
  return 0;
}

async function countLines(abs: string): Promise<number> {
  const buf = await readFile(abs);
  let n = 0;
  for (const b of buf) if (b === 10) n += 1;
  return buf.length && buf[buf.length - 1] !== 10 ? n + 1 : n;
}

async function looksBinary(abs: string): Promise<boolean> {
  const fh = await open(abs, "r");
  try {
    const buf = Buffer.alloc(8192);
    const { bytesRead } = await fh.read(buf, 0, 8192, 0);
    for (let i = 0; i < bytesRead; i++) if (buf[i] === 0) return true;
    return false;
  } finally {
    await fh.close();
  }
}

/** Read a bounded, UTF-8 excerpt of a file for an LLM prompt. */
export async function readExcerpt(root: string, relPath: string, maxChars: number = LIMITS.maxCharsPerFileForLlm): Promise<string> {
  const content = await readFile(path.join(root, ...relPath.split("/")), "utf8");
  if (content.length <= maxChars) return content;
  const head = Math.floor(maxChars * 0.7);
  const tail = maxChars - head;
  return `${content.slice(0, head)}\n\n[... ${content.length - maxChars} characters omitted ...]\n\n${content.slice(-tail)}`;
}

/** Cheap symbol extraction for the file-summary prompt (and the mock provider). */
export function extractSymbols(content: string): string[] {
  const out = new Set<string>();
  const re = /(?:^|\n)\s*(?:export\s+)?(?:async\s+)?(?:function|class|def|interface|type|const|let|var|func|fn|struct|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) && out.size < 20) if (m[1]) out.add(m[1]);
  const routeRe = /\.(get|post|put|patch|delete)\(\s*['"`]([^'"`]+)['"`]/g;
  while ((m = routeRe.exec(content)) && out.size < 30) out.add(`${m[1]!.toUpperCase()} ${m[2]}`);
  return [...out];
}
