import {
  copyFile,
  lstat,
  mkdir,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import { dirname, basename, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { readMetadata, type SourceMetadata } from "./metadata.ts";
import { scanCheckedDirectory, type ScanResult, type ScannedSource } from "./scanner.ts";

export type ArchiveAction = "replace" | "move" | "no-op" | "error";
export type MatchStatus = "update" | "unchanged" | "lower" | "new";

export function compareVersionStrings(left: string, right: string): number {
  const leftParts = /^v?(\d+(?:\.\d+)*)$/i.exec(left.trim());
  const rightParts = /^v?(\d+(?:\.\d+)*)$/i.exec(right.trim());
  if (leftParts && rightParts) {
    const leftNumbers = leftParts[1]!.split(".").map(Number);
    const rightNumbers = rightParts[1]!.split(".").map(Number);
    const length = Math.max(leftNumbers.length, rightNumbers.length);
    for (let index = 0; index < length; index += 1) {
      const difference = (leftNumbers[index] ?? 0) - (rightNumbers[index] ?? 0);
      if (difference !== 0) return difference > 0 ? 1 : -1;
    }
    return 0;
  }
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
}

export interface ArchivePlan {
  action: ArchiveAction;
  sourcePath: string;
  targetPath?: string;
  metadata: SourceMetadata;
  matches: ScannedSource[];
  matchStatus: MatchStatus;
  scanErrors: string[];
  error?: string;
}

export interface ArchiveOptions {
  sourcePath: string;
  checkedRoot: string;
  uncheckedRoot: string;
  dryRun?: boolean;
}

function samePath(left: string, right: string): boolean {
  return resolve(left) === resolve(right);
}

function isInside(path: string, root: string): boolean {
  const resolvedPath = resolve(path);
  const resolvedRoot = resolve(root);
  return resolvedPath === resolvedRoot || resolvedPath.startsWith(`${resolvedRoot}/`) || resolvedPath.startsWith(`${resolvedRoot}\\`);
}

function matchesMetadata(left: SourceMetadata, right: SourceMetadata): boolean {
  return left.name === right.name && left.author === right.author;
}

export async function createArchivePlan(options: ArchiveOptions): Promise<ArchivePlan> {
  const sourcePath = resolve(options.sourcePath);
  const checkedRoot = resolve(options.checkedRoot);
  const uncheckedRoot = resolve(options.uncheckedRoot);
  const metadata = await readMetadata(sourcePath);
  const sourceStats = await lstat(sourcePath);
  if (!sourceStats.isFile()) throw new Error(`${sourcePath}: source is not a regular file`);
  if (!isInside(sourcePath, uncheckedRoot)) {
    throw new Error(`${sourcePath}: source is outside the unchecked directory`);
  }

  const scan: ScanResult = await scanCheckedDirectory(checkedRoot);
  const matches = scan.sources.filter((candidate) => matchesMetadata(candidate.metadata, metadata));

  if (matches.length > 1) {
    return {
      action: "error",
      sourcePath,
      metadata,
      matches,
      matchStatus: "new",
      scanErrors: scan.errors,
      error: "multiple checked files have the same name and author",
    };
  }

  const targetPath = matches.length === 1
    ? resolve(dirname(matches[0]!.path), basename(sourcePath))
    : resolve(checkedRoot, basename(sourcePath));
  const matchStatus: MatchStatus = matches.length === 0
    ? "new"
    : compareVersionStrings(metadata.version, matches[0]!.metadata.version) > 0
      ? "update"
      : compareVersionStrings(metadata.version, matches[0]!.metadata.version) < 0
        ? "lower"
        : "unchanged";

  return {
    action: samePath(sourcePath, targetPath) ? "no-op" : matches.length === 1 ? "replace" : "move",
    sourcePath,
    targetPath,
    metadata,
    matches,
    matchStatus,
    scanErrors: scan.errors,
  };
}

async function makeTempPath(directory: string, label: string): Promise<string> {
  return resolve(directory, `.${label}-${randomUUID()}.tmp`);
}

async function copyToTemp(sourcePath: string, targetPath: string): Promise<string> {
  const temporaryPath = await makeTempPath(dirname(targetPath), "source");
  await copyFile(sourcePath, temporaryPath);
  return temporaryPath;
}

async function replaceFile(sourcePath: string, targetPath: string): Promise<void> {
  const temporaryPath = await copyToTemp(sourcePath, targetPath);
  const backupPath = await makeTempPath(dirname(targetPath), "backup");
  let targetBackedUp = false;
  try {
    await rename(targetPath, backupPath);
    targetBackedUp = true;
    await rename(temporaryPath, targetPath);
    await unlink(sourcePath);
    await rm(backupPath, { force: true });
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    if (targetBackedUp) {
      await rm(targetPath, { force: true }).catch(() => undefined);
      await rename(backupPath, targetPath).catch(() => undefined);
    }
    throw error;
  }
}

async function replaceMatchedFile(sourcePath: string, oldTargetPath: string, targetPath: string): Promise<void> {
  if (samePath(oldTargetPath, targetPath)) {
    await replaceFile(sourcePath, targetPath);
    return;
  }

  const backupPath = await makeTempPath(dirname(oldTargetPath), "backup");
  const temporaryPath = await copyToTemp(sourcePath, targetPath);
  let oldTargetBackedUp = false;
  let newTargetInstalled = false;
  let sourceRemoved = false;
  try {
    await rename(oldTargetPath, backupPath);
    oldTargetBackedUp = true;
    await rename(temporaryPath, targetPath);
    newTargetInstalled = true;
    await unlink(sourcePath);
    sourceRemoved = true;
    await rm(backupPath, { force: true });
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    if (newTargetInstalled) await rm(targetPath, { force: true }).catch(() => undefined);
    if (oldTargetBackedUp) await rename(backupPath, oldTargetPath).catch(() => undefined);
    if (sourceRemoved) {
      // The source was removed only after the new target was installed. If rollback
      // is needed, retain the new target rather than inventing source contents.
    }
    throw error;
  }
}

async function moveFile(sourcePath: string, targetPath: string): Promise<void> {
  try {
    await rename(sourcePath, targetPath);
    return;
  } catch {
    const temporaryPath = await copyToTemp(sourcePath, targetPath);
    try {
      await rename(temporaryPath, targetPath);
      await unlink(sourcePath);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}

export async function executeArchivePlan(plan: ArchivePlan, dryRun = false): Promise<void> {
  if (plan.action === "error") throw new Error(plan.error ?? "archive plan is invalid");
  if (plan.action === "no-op" || dryRun) return;
  const targetPath = plan.targetPath;
  if (!targetPath) throw new Error("archive plan has no target");

  await mkdir(dirname(targetPath), { recursive: true });
  if (plan.action === "replace") {
    const oldTargetPath = plan.matches[0]?.path;
    if (!oldTargetPath) throw new Error("archive plan has no matched target");
    if (!samePath(oldTargetPath, targetPath)) {
      try {
        await lstat(targetPath);
        throw new Error(`${targetPath}: target filename already exists`);
      } catch (error) {
        if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) {
          throw error;
        }
      }
    }
    await replaceMatchedFile(plan.sourcePath, oldTargetPath, targetPath);
    return;
  }

  try {
    await lstat(targetPath);
    throw new Error(`${targetPath}: target already exists`);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      // The destination is absent, so the move can proceed.
    } else {
      throw error;
    }
  }
  await moveFile(plan.sourcePath, targetPath);
}
