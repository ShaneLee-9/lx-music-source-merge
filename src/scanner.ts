import { lstat, readdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { MetadataError, readMetadata, type SourceMetadata } from "./metadata.ts";

export interface ScannedSource {
  path: string;
  metadata: SourceMetadata;
}

export interface ScanResult {
  sources: ScannedSource[];
  errors: string[];
}

export async function scanCheckedDirectory(root: string): Promise<ScanResult> {
  const sources: ScannedSource[] = [];
  const errors: string[] = [];
  const visited = new Set<string>();

  async function visit(directory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      errors.push(`${directory}: directory could not be read`);
      return;
    }

    for (const entry of entries) {
      const path = join(directory, entry.name);
      let stats;
      try {
        stats = await lstat(path);
      } catch {
        errors.push(`${path}: path could not be inspected`);
        continue;
      }

      if (stats.isDirectory()) {
        await visit(path);
        continue;
      }
      if (!stats.isFile()) continue;

      let canonicalPath: string;
      try {
        canonicalPath = await realpath(path);
      } catch {
        errors.push(`${path}: path could not be resolved`);
        continue;
      }
      if (visited.has(canonicalPath)) continue;
      visited.add(canonicalPath);

      try {
        sources.push({ path: resolve(path), metadata: await readMetadata(path) });
      } catch (error) {
        if (!(error instanceof MetadataError && error.code === "missing-jsdoc")) {
          errors.push(`${path}: invalid or unreadable source metadata`);
        }
      }
    }
  }

  await visit(resolve(root));
  return { sources, errors };
}
