import { pruneDuplicateUncheckedFiles } from "./prune.ts";

function parseArgs(args: string[]): { checkedRoot: string; uncheckedRoot: string; help: boolean } {
  let checkedRoot = "checked";
  let uncheckedRoot = "unchecked";

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--help") return { checkedRoot, uncheckedRoot, help: true };
    if (arg === "--checked" || arg === "--unchecked") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${arg}: a directory is required`);
      if (arg === "--checked") checkedRoot = value;
      else uncheckedRoot = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown option: ${arg}`);
  }

  return { checkedRoot, uncheckedRoot, help: false };
}

async function run(): Promise<number> {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log("Usage: bun run prune [--checked <dir>] [--unchecked <dir>]");
      return 0;
    }

    const result = await pruneDuplicateUncheckedFiles(options);
    console.log(JSON.stringify(result, null, 2));
    return result.errors.length > 0 ? 1 : 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : "operation failed";
    console.error(JSON.stringify({ error: message }));
    return 1;
  }
}

const exitCode = await run();
if (exitCode !== 0) process.exitCode = exitCode;
