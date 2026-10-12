import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ExtractionError, extractZip, validateGitHubUrl } from "../src/pipeline/extract.js";
import { buildZip } from "../src/util/mini-zip.js";

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "pe-extract-"));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

async function zipFile(entries: Parameters<typeof buildZip>[0]): Promise<string> {
  const p = path.join(tmp, "in.zip");
  await writeFile(p, buildZip(entries));
  return p;
}

describe("extractZip", () => {
  it("extracts a normal archive", async () => {
    const zip = await zipFile([
      { name: "README.md", data: Buffer.from("# hi\n") },
      { name: "src/", data: Buffer.alloc(0), method: 0 },
      { name: "src/index.js", data: Buffer.from("console.log(1)\n") },
    ]);
    const out = path.join(tmp, "out");
    const stats = await extractZip(zip, out);
    expect(stats.fileCount).toBe(2);
    expect(await readFile(path.join(out, "src", "index.js"), "utf8")).toContain("console.log");
  });

  it("rejects path traversal entry names", async () => {
    const zip = await zipFile([{ name: "../../evil.txt", data: Buffer.from("pwned") }]);
    await expect(extractZip(zip, path.join(tmp, "out"))).rejects.toMatchObject({ code: "path_traversal" });
    await expect(stat(path.join(tmp, "evil.txt"))).rejects.toThrow();
  });

  it("rejects absolute paths and backslash paths", async () => {
    for (const name of ["/etc/passwd", "C:\\Windows\\win.ini", "a\\..\\b.txt"]) {
      const zip = await zipFile([{ name, data: Buffer.from("x") }]);
      await expect(extractZip(zip, path.join(tmp, "out"))).rejects.toBeInstanceOf(ExtractionError);
    }
  });

  it("skips symlink entries", async () => {
    const zip = await zipFile([
      { name: "link", data: Buffer.from("/etc/passwd"), unixMode: 0o120777 },
      { name: "ok.txt", data: Buffer.from("fine") },
    ]);
    const out = path.join(tmp, "out");
    const stats = await extractZip(zip, out);
    expect(stats.fileCount).toBe(1);
    await expect(stat(path.join(out, "link"))).rejects.toThrow();
  });

  it("rejects a zip bomb by compression ratio", async () => {
    // 8 MiB of zeros deflates to a few KiB: ratio in the thousands.
    const zip = await zipFile([{ name: "bomb.bin", data: Buffer.alloc(8 * 1024 * 1024, 0) }]);
    await expect(extractZip(zip, path.join(tmp, "out"))).rejects.toMatchObject({ code: "zip_bomb" });
  });

  it("aborts when an entry is larger than its header declares", async () => {
    const real = Buffer.from("x".repeat(50_000));
    const zip = await zipFile([{ name: "liar.txt", data: real, declaredUncompressedSize: 10 }]);
    await expect(extractZip(zip, path.join(tmp, "out"))).rejects.toBeInstanceOf(ExtractionError);
  });

  it("rejects corrupt input", async () => {
    const p = path.join(tmp, "junk.zip");
    await writeFile(p, Buffer.from("this is not a zip file at all"));
    await expect(extractZip(p, path.join(tmp, "out"))).rejects.toMatchObject({ code: "corrupt_archive" });
  });
});

describe("validateGitHubUrl", () => {
  it("accepts only https github.com repository URLs", () => {
    expect(validateGitHubUrl("https://github.com/octocat/Hello-World")).toBe("https://github.com/octocat/Hello-World.git");
    expect(validateGitHubUrl("https://github.com/octocat/Hello-World.git/")).toBe("https://github.com/octocat/Hello-World.git");
    for (const bad of [
      "git@github.com:octocat/Hello-World.git",
      "https://gitlab.com/x/y",
      "https://github.com/octocat",
      "https://user:token@github.com/octocat/Hello-World",
      "https://github.com/octocat/Hello-World/tree/main/src",
      "file:///etc/passwd",
    ]) {
      expect(() => validateGitHubUrl(bad)).toThrow(ExtractionError);
    }
  });
});
