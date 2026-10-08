import { unlink } from "node:fs/promises";
import { createArchivePlan } from "./archive.ts";
import { discoverUncheckedFiles } from "./interactive.ts";

export interface PruneOptions {
  checkedRoot: string;
  uncheckedRoot: string;
}

export interface PruneResult {
  deleted: string[];
  kept: string[];
  errors: string[];
}

export async function pruneDuplicateUncheckedFiles(options: PruneOptions): Promise<PruneResult> {
  const scan = await discoverUncheckedFiles(options.uncheckedRoot);
  const result: PruneResult = { deleted: [], kept: [], errors: [...scan.errors] };

  for (const candidate of scan.candidates) {
    try {
      const plan = await createArchivePlan({
        sourcePath: candidate.path,
        checkedRoot: options.checkedRoot,
        uncheckedRoot: options.uncheckedRoot,
      });

      if (plan.scanErrors.length > 0) {
        result.kept.push(candidate.path);
        result.errors.push(...plan.scanErrors);
        continue;
      }
      if (plan.matches.length > 1) {
        result.kept.push(candidate.path);
        result.errors.push(`${candidate.path}: multiple checked files have the same name and author`);
        continue;
      }
      if (plan.matches.length === 0 || plan.action !== "replace") {
        result.kept.push(candidate.path);
        continue;
      }

      await unlink(candidate.path);
      result.deleted.push(candidate.path);
    } catch {
      result.kept.push(candidate.path);
      result.errors.push(`${candidate.path}: could not be compared or removed`);
    }
  }

  return result;
}
