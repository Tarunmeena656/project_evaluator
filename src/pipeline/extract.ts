import { execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import yauzl from "yauzl";
import { LIMITS } from "../config.js";
import type { ObjectStore } from "../storage/object-store.js";
import type { SourceRow } from "./context.js";

const execFileAsync = promisify(execFile);

export class ExtractionError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "corrupt_archive"
      | "zip_bomb"
      | "path_traversal"
      | "too_many_entries"
      | "too_large"
      | "invalid_repository"
      | "clone_failed"
      | "unsupported_source",
  ) {
    super(message);
    this.name = "ExtractionError";
  }
}

export interface ExtractManifest {
  rootDir: string;
  fileCount: number;
  totalBytes: number;
  sources: Array<{ id: string; kind: string; note: string }>;
  warnings: string[];
}

/**
 * Materialise all sources of a submission under `rootDir`.
 *   - zip:    streamed, validated entry-by-entry (see extractZip)
 *   - github: shallow clone with a timeout, .git removed afterwards
 *   - pdf/docs: copied under _documents/ (text extraction is a documented extension)
 *   - video/drive/live_url: recorded as metadata only in this PoC
 * Nothing from the submission is ever executed.
 */
export async function extractSubmission(
  store: ObjectStore,
  sources: SourceRow[],
  rootDir: string,
): Promise<ExtractManifest> {
  await rm(rootDir, { recursive: true, force: true });
  await mkdir(rootDir, { recursive: true });
  const manifest: ExtractManifest = { rootDir, fileCount: 0, totalBytes: 0, sources: [], warnings: [] };
  const meta: Record<string, unknown>[] = [];

  for (const [i, src] of sources.entries()) {
    switch (src.kind) {
      case "zip": {
        if (!src.object_key) throw new ExtractionError("zip source has no uploaded object", "corrupt_archive");
        const archivePath = path.join(rootDir, `..`, `${path.basename(rootDir)}-src${i}.zip`);
        await pipeline(await store.getStream(src.object_key), createWriteStream(archivePath));
        const target = sources.length === 1 ? rootDir : path.join(rootDir, `source-${i}`);
        const r = await extractZip(archivePath, target);
        await rm(archivePath, { force: true });
        manifest.fileCount += r.fileCount;
        manifest.totalBytes += r.totalBytes;
        manifest.sources.push({ id: src.id, kind: src.kind, note: `${r.fileCount} files, ${r.totalBytes} bytes` });
        break;
      }
      case "github": {
        const url = validateGitHubUrl(src.url ?? "");
        const target = sources.length === 1 ? rootDir : path.join(rootDir, `source-${i}`);
        const r = await shallowClone(url, target);
        manifest.fileCount += r.fileCount;
        manifest.totalBytes += r.totalBytes;
        manifest.sources.push({ id: src.id, kind: src.kind, note: `cloned ${url} (${r.fileCount} files)` });
        break;
      }
      case "pdf":
      case "docs": {
        if (!src.object_key) throw new ExtractionError(`${src.kind} source has no uploaded object`, "unsupported_source");
        const docsDir = path.join(rootDir, "_documents");
        await mkdir(docsDir, { recursive: true });
        const safeName = (src.filename ?? `${src.kind}-${i}`).replace(/[^A-Za-z0-9._-]/g, "_");
        const dest = path.join(docsDir, safeName);
        await pipeline(await store.getStream(src.object_key), createWriteStream(dest));
        const s = await stat(dest);
        manifest.fileCount += 1;
        manifest.totalBytes += s.size;
        manifest.sources.push({ id: src.id, kind: src.kind, note: `stored as _documents/${safeName}` });
        manifest.warnings.push(`${src.kind} text extraction not implemented in PoC; file inventoried only`);
        break;
      }
      case "video":
      case "drive":
      case "live_url": {
        meta.push({ id: src.id, kind: src.kind, url: src.url });
        manifest.sources.push({ id: src.id, kind: src.kind, note: "metadata only (not fetched in PoC)" });
        manifest.warnings.push(`${src.kind} source recorded as metadata; transcription/probing is a production extension`);
        break;
      }
      default:
        throw new ExtractionError(`unsupported source kind ${String(src.kind)}`, "unsupported_source");
    }
  }

  if (meta.length) {
    const metaDir = path.join(rootDir, "_meta");
    await mkdir(metaDir, { recursive: true });
    await writeFile(path.join(metaDir, "sources.json"), JSON.stringify(meta, null, 2));
  }
  return manifest;
}

// ---------------------------------------------------------------------------
// ZIP
// ---------------------------------------------------------------------------

interface ZipStats {
  fileCount: number;
  totalBytes: number;
}

/**
 * Safe streaming extraction. Defences:
 *  - entry names validated (no absolute paths, no "..", no backslashes) AND the
 *    resolved path is checked to stay inside `targetDir`
 *  - symlink entries are skipped (a symlink + later write = traversal)
 *  - entry count, per-entry size, total size and compression ratio are capped
 *  - yauzl validates actual vs declared sizes while inflating, so a header that
 *    lies about its size aborts the extraction instead of filling the disk
 */
export async function extractZip(archivePath: string, targetDir: string): Promise<ZipStats> {
  await mkdir(targetDir, { recursive: true });
  const targetAbs = path.resolve(targetDir);
  const zipfile = await openZip(archivePath);
  const stats: ZipStats = { fileCount: 0, totalBytes: 0 };

  if (zipfile.entryCount > LIMITS.maxArchiveEntries) {
    zipfile.close();
    throw new ExtractionError(`archive has ${zipfile.entryCount} entries (limit ${LIMITS.maxArchiveEntries})`, "too_many_entries");
  }

  await new Promise<void>((resolve, reject) => {
    const fail = (err: Error) => {
      zipfile.close();
      reject(err);
    };
    // yauzl validates entry names itself (absolute paths, "..", backslashes) and
    // reports them here; surface them as traversal attempts, not corruption.
    zipfile.on("error", (err: Error) =>
      fail(
        /absolute path|invalid relative path|invalid characters in fileName/i.test(err.message)
          ? new ExtractionError(`unsafe entry name: ${err.message}`, "path_traversal")
          : new ExtractionError(`corrupt archive: ${err.message}`, "corrupt_archive"),
      ),
    );
    zipfile.on("end", () => resolve());
    zipfile.on("entry", (entry: yauzl.Entry) => {
      void (async () => {
        try {
          const invalid = yauzl.validateFileName(entry.fileName);
          if (invalid) throw new ExtractionError(`unsafe entry name "${entry.fileName}": ${invalid}`, "path_traversal");

          const dest = path.resolve(targetAbs, entry.fileName);
          if (dest !== targetAbs && !dest.startsWith(targetAbs + path.sep)) {
            throw new ExtractionError(`entry escapes target dir: ${entry.fileName}`, "path_traversal");
          }

          const isDir = entry.fileName.endsWith("/");
          const unixMode = (entry.externalFileAttributes >>> 16) & 0o170000;
          const isSymlink = unixMode === 0o120000;

          if (isDir) {
            await mkdir(dest, { recursive: true });
          } else if (isSymlink) {
            // skip silently; symlinks are never materialised
          } else {
            if (entry.uncompressedSize > LIMITS.maxSingleFileBytes) {
              throw new ExtractionError(`entry ${entry.fileName} is ${entry.uncompressedSize} bytes`, "too_large");
            }
            const ratio = entry.compressedSize > 0 ? entry.uncompressedSize / entry.compressedSize : 1;
            if (entry.uncompressedSize > 1024 * 1024 && ratio > LIMITS.maxCompressionRatio) {
              throw new ExtractionError(`entry ${entry.fileName} has compression ratio ${ratio.toFixed(0)}:1`, "zip_bomb");
            }
            if (stats.totalBytes + entry.uncompressedSize > LIMITS.maxExtractedBytes) {
              throw new ExtractionError(`archive expands beyond ${LIMITS.maxExtractedBytes} bytes`, "too_large");
            }
            await mkdir(path.dirname(dest), { recursive: true });
            const readStream = await openEntry(zipfile, entry);
            let written = 0;
            const guard = async function* (src: AsyncIterable<Buffer>) {
              for await (const chunk of src) {
                written += chunk.length;
                if (written > entry.uncompressedSize) {
                  throw new ExtractionError(`entry ${entry.fileName} larger than declared`, "zip_bomb");
                }
                yield chunk;
              }
            };
            await pipeline(readStream, guard, createWriteStream(dest));
            stats.fileCount += 1;
            stats.totalBytes += written;
          }
          zipfile.readEntry();
        } catch (err) {
          const e =
            err instanceof ExtractionError
              ? err
              : new ExtractionError(`corrupt archive: ${(err as Error).message}`, "corrupt_archive");
          fail(e);
        }
      })();
    });
    zipfile.readEntry();
  });

  return stats;
}

function openZip(archivePath: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(archivePath, { lazyEntries: true, autoClose: false, validateEntrySizes: true }, (err, zipfile) => {
      if (err || !zipfile) return reject(new ExtractionError(`cannot open archive: ${err?.message ?? "unknown"}`, "corrupt_archive"));
      resolve(zipfile);
    });
  });
}

function openEntry(zipfile: yauzl.ZipFile, entry: yauzl.Entry): Promise<Readable> {
  return new Promise((resolve, reject) => {
    zipfile.openReadStream(entry, (err, stream) => {
      if (err || !stream) return reject(err ?? new Error("no stream"));
      resolve(stream as unknown as Readable);
    });
  });
}

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

const GITHUB_RE = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/;

/** Only https://github.com/owner/repo is accepted - no SSH, no arbitrary hosts, no credentials in URL. */
export function validateGitHubUrl(url: string): string {
  const m = GITHUB_RE.exec(url.trim());
  if (!m) throw new ExtractionError(`not a valid GitHub repository URL: ${url}`, "invalid_repository");
  return `https://github.com/${m[1]}/${m[2]}.git`;
}

async function shallowClone(url: string, targetDir: string): Promise<ZipStats> {
  await mkdir(path.dirname(targetDir), { recursive: true });
  try {
    await execFileAsync("git", ["clone", "--depth", "1", "--single-branch", "--no-tags", "--", url, targetDir], {
      timeout: LIMITS.gitCloneTimeoutMs,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "echo" }, // never prompt for credentials
      maxBuffer: 1024 * 1024,
    });
  } catch (err) {
    const msg = (err as Error).message.split("\n")[0] ?? "clone failed";
    throw new ExtractionError(`git clone failed: ${msg}`, "clone_failed");
  }
  await rm(path.join(targetDir, ".git"), { recursive: true, force: true });
  const s = await dirStats(targetDir);
  if (s.totalBytes > LIMITS.maxExtractedBytes) {
    await rm(targetDir, { recursive: true, force: true });
    throw new ExtractionError(`repository is ${s.totalBytes} bytes (limit ${LIMITS.maxExtractedBytes})`, "too_large");
  }
  return s;
}

export async function dirStats(dir: string): Promise<ZipStats> {
  const { readdir, lstat } = await import("node:fs/promises");
  const out: ZipStats = { fileCount: 0, totalBytes: 0 };
  const walk = async (d: string): Promise<void> => {
    for (const name of await readdir(d)) {
      const p = path.join(d, name);
      const st = await lstat(p);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) await walk(p);
      else {
        out.fileCount += 1;
        out.totalBytes += st.size;
      }
    }
  };
  await walk(dir);
  return out;
}
