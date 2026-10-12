import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";

export interface PutResult {
  sizeBytes: number;
  sha256: string;
}

/**
 * Object storage abstraction. PoC: local disk. Production: S3 (presigned
 * multipart uploads from the browser, server-side encryption, lifecycle rules).
 */
export interface ObjectStore {
  putStream(key: string, body: Readable, maxBytes: number): Promise<PutResult>;
  putText(key: string, text: string): Promise<void>;
  getText(key: string): Promise<string>;
  getStream(key: string): Promise<Readable>;
  exists(key: string): Promise<boolean>;
}

export class ObjectTooLargeError extends Error {
  constructor(public readonly maxBytes: number) {
    super(`object exceeds the ${maxBytes} byte limit`);
  }
}

export class LocalObjectStore implements ObjectStore {
  constructor(private readonly root: string) {}

  /** Resolve a key under root and refuse anything that escapes it. */
  private resolve(key: string): string {
    if (!/^[A-Za-z0-9/_\-.]+$/.test(key) || key.includes("..")) {
      throw new Error(`invalid object key: ${key}`);
    }
    const abs = path.resolve(this.root, key);
    const rootAbs = path.resolve(this.root);
    if (!abs.startsWith(rootAbs + path.sep)) throw new Error(`object key escapes store root: ${key}`);
    return abs;
  }

  async putStream(key: string, body: Readable, maxBytes: number): Promise<PutResult> {
    const file = this.resolve(key);
    await mkdir(path.dirname(file), { recursive: true });
    const hash = createHash("sha256");
    let size = 0;
    const counter = async function* (source: AsyncIterable<Buffer>) {
      for await (const chunk of source) {
        size += chunk.length;
        if (size > maxBytes) throw new ObjectTooLargeError(maxBytes);
        hash.update(chunk);
        yield chunk;
      }
    };
    await pipeline(body, counter, createWriteStream(file));
    return { sizeBytes: size, sha256: hash.digest("hex") };
  }

  async putText(key: string, text: string): Promise<void> {
    const file = this.resolve(key);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text, "utf8");
  }

  async getText(key: string): Promise<string> {
    return readFile(this.resolve(key), "utf8");
  }

  async getStream(key: string): Promise<Readable> {
    return createReadStream(this.resolve(key));
  }

  async exists(key: string): Promise<boolean> {
    try {
      await access(this.resolve(key));
      return true;
    } catch {
      return false;
    }
  }
}
