import { createArchivePlan, executeArchivePlan, type ArchiveOptions } from "./archive.ts";
import { MetadataError } from "./metadata.ts";
import { confirmArchivePlan, selectUncheckedFile } from "./interactive.ts";

interface CliOptions extends Omit<ArchiveOptions, "sourcePath"> {
  sourcePath?: string;
  help: boolean;
  interactive: boolean;
}

function usage(): string {
  return [
    "Usage: bun run index.ts [<unchecked-file>] [options]",
    "",
    "Without a file argument, an interactive selector opens for unchecked sources.",
    "",
    "Options:",
    "  --checked <dir>    Checked source root (default: checked)",
    "  --unchecked <dir>  Unchecked source root (default: unchecked)",
    "  --dry-run          Preview without changing files",
    "  --help             Show this help",
  ].join("\n");
}

function requireValue(args: string[], index: number, option: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${option}: a value is required`);
  return value;
}

export function parseArgs(args: string[]): CliOptions {
  if (args.includes("--help")) {
    return {
      checkedRoot: "checked",
      uncheckedRoot: "unchecked",
      dryRun: false,
      help: true,
      interactive: false,
    };
  }

  if (args.length === 0) {
    return {
      checkedRoot: "checked",
      uncheckedRoot: "unchecked",
      dryRun: false,
      help: false,
      interactive: true,
    };
  }

  let sourcePath: string | undefined;
  let checkedRoot = "checked";
  let uncheckedRoot = "unchecked";
  let dryRun = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--checked") {
      checkedRoot = requireValue(args, index, arg);
      index += 1;
    } else if (arg === "--unchecked") {
      uncheckedRoot = requireValue(args, index, arg);
      index += 1;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown option: ${arg}`);
    } else if (sourcePath === undefined) {
      sourcePath = arg;
    } else {
      throw new Error(`unexpected argument: ${arg}`);
    }
  }

  if (!sourcePath) return { checkedRoot, uncheckedRoot, dryRun, help: false, interactive: true };
  return { sourcePath, checkedRoot, uncheckedRoot, dryRun, help: false, interactive: false };
}

export async function runCli(args: string[]): Promise<number> {
  try {
    const options = parseArgs(args);
    if (options.help) {
      console.log(usage());
      return 0;
    }

    if (options.interactive) {
      const selection = await selectUncheckedFile(options.uncheckedRoot);
      if (selection.cancelled) return 0;
      if (!selection.path) {
        if (selection.errors.length === 0) {
          console.log(JSON.stringify({ action: "skipped", reason: "no unchecked sources with JSDoc metadata found" }));
          return 0;
        }
        console.error(JSON.stringify({ action: "error", error: "no valid unchecked source files found", scanErrors: selection.errors }));
        return 1;
      }
      options.sourcePath = selection.path;
    }

    if (!options.sourcePath) throw new Error("an unchecked source file is required");
    const archiveOptions: ArchiveOptions = {
      sourcePath: options.sourcePath,
      checkedRoot: options.checkedRoot,
      uncheckedRoot: options.uncheckedRoot,
      dryRun: options.dryRun,
    };
    const plan = await createArchivePlan(archiveOptions);
    const result = {
      action: plan.action,
      sourcePath: plan.sourcePath,
      targetPath: plan.targetPath,
      metadata: plan.metadata,
      matches: plan.matches.map((match) => ({ path: match.path, metadata: match.metadata })),
      matchStatus: plan.matchStatus,
      scanErrors: plan.scanErrors,
      dryRun: options.dryRun ?? false,
      error: plan.error,
    };
    if (options.interactive) {
      if (plan.action === "error" || plan.scanErrors.length > 0) {
        console.log(JSON.stringify(result, null, 2));
        return 1;
      }
      const confirmed = await confirmArchivePlan(plan);
      if (!confirmed) return 0;
    } else {
      console.log(JSON.stringify(result, null, 2));
    }

    if (plan.action === "error") return 1;
    await executeArchivePlan(plan, options.dryRun);
    if (options.interactive) {
      console.log(options.dryRun ? "预览完成，未修改文件。" : `归档完成：${plan.action}`);
    }
    return plan.scanErrors.length > 0 ? 1 : 0;
  } catch (error) {
    if (error instanceof MetadataError && error.code === "missing-jsdoc") {
      console.log(JSON.stringify({ action: "skipped", error: error.message }));
      return 0;
    }
    const message = error instanceof Error ? error.message : "operation failed";
    console.error(JSON.stringify({ action: "error", error: message }));
    return 1;
  }
}
