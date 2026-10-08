import { lstat, readdir, realpath } from "node:fs/promises";
import { basename, relative, resolve } from "node:path";
import { emitKeypressEvents } from "node:readline";
import type { ArchivePlan } from "./archive.ts";
import { MetadataError, readMetadata, type SourceMetadata } from "./metadata.ts";

export interface UncheckedCandidate {
  path: string;
  fileName: string;
  displayPath: string;
  metadata: SourceMetadata;
}

export interface CandidateScanResult {
  candidates: UncheckedCandidate[];
  errors: string[];
}

export interface InteractiveSelection {
  path?: string;
  cancelled: boolean;
  errors: string[];
}

export async function discoverUncheckedFiles(root: string): Promise<CandidateScanResult> {
  const resolvedRoot = resolve(root);
  const candidates: UncheckedCandidate[] = [];
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
      const path = resolve(directory, entry.name);
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
      if (!basename(path).toLocaleLowerCase().endsWith(".js")) continue;

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
        candidates.push({
          path,
          fileName: basename(path),
          displayPath: relative(resolvedRoot, path) || basename(path),
          metadata: await readMetadata(path),
        });
      } catch (error) {
        if (!(error instanceof MetadataError && error.code === "missing-jsdoc")) {
          errors.push(`${path}: invalid or unreadable source metadata`);
        }
      }
    }
  }

  await visit(resolvedRoot);
  candidates.sort((left, right) => left.displayPath.localeCompare(right.displayPath));
  return { candidates, errors };
}

export function filterCandidates(candidates: UncheckedCandidate[], query: string): UncheckedCandidate[] {
  const normalizedQuery = query.toLocaleLowerCase();
  if (normalizedQuery.length === 0) return candidates;
  return candidates.filter((candidate) => candidate.fileName.toLocaleLowerCase().includes(normalizedQuery));
}

interface TerminalInput {
  isTTY?: boolean;
  setRawMode(mode: boolean): void;
  resume(): void;
  pause(): void;
  on(event: "keypress", listener: (value: string, key: { name?: string; ctrl?: boolean; sequence?: string }) => void): void;
  removeListener(event: "keypress", listener: (value: string, key: { name?: string; ctrl?: boolean; sequence?: string }) => void): void;
}

interface TerminalOutput {
  write(value: string): boolean;
}

function clearScreen(output: TerminalOutput): void {
  output.write("\x1b[2J\x1b[H");
}

function renderSelector(
  output: TerminalOutput,
  candidates: UncheckedCandidate[],
  filtered: UncheckedCandidate[],
  selectedIndex: number,
  query: string,
  errorCount: number,
): void {
  clearScreen(output);
  output.write("选择要归档的音源（输入可按文件名搜索，↑↓选择，Enter确认，Esc/q退出）\n");
  output.write(`搜索: ${query || "(全部)"}\n`);
  output.write(`结果: ${filtered.length}/${candidates.length}`);
  if (errorCount > 0) output.write(`，跳过无效文件: ${errorCount}`);
  output.write("\n\n");

  if (filtered.length === 0) {
    output.write("没有匹配的文件，请修改搜索词。\n");
    return;
  }

  for (const [index, candidate] of filtered.entries()) {
    const marker = index === selectedIndex ? ">" : " ";
    output.write(`${marker} ${candidate.displayPath}  [${candidate.metadata.name} / ${candidate.metadata.version} / ${candidate.metadata.author}]\n`);
  }
}

function colorize(value: string, color: string): string {
  return `${color}${value}\x1b[0m`;
}

function matchStatusLabel(plan: ArchivePlan): string {
  if (plan.matchStatus === "update") return colorize("更新", "\x1b[32m");
  if (plan.matchStatus === "unchanged") return colorize("没有变化", "\x1b[90m");
  if (plan.matchStatus === "lower") return colorize("版本更低不建议替换", "\x1b[33m");
  return colorize("没有匹配，将新增", "\x1b[36m");
}

function renderPlan(output: TerminalOutput, plan: ArchivePlan): void {
  clearScreen(output);
  output.write("归档预览\n\n");
  output.write(`名称: ${plan.metadata.name}\n版本: ${plan.metadata.version}\n作者: ${plan.metadata.author}\n`);
  output.write(`匹配结果: ${matchStatusLabel(plan)}\n`);
  output.write(`操作: ${plan.action}\n源文件: ${plan.sourcePath}\n`);
  if (plan.targetPath) output.write(`目标文件: ${plan.targetPath}\n`);
  if (plan.matches.length > 0) output.write(`匹配文件: ${plan.matches.map((match) => match.path).join(", ")}\n`);
  if (plan.scanErrors.length > 0) output.write(`扫描警告: ${plan.scanErrors.length} 个\n`);
  if (plan.error) output.write(`错误: ${plan.error}\n`);
  output.write("\n按 Enter 确认归档（所有匹配结果都可以执行），按 Esc/q 取消。\n");
}

async function waitForConfirmation(input: TerminalInput, output: TerminalOutput, plan: ArchivePlan): Promise<boolean> {
  renderPlan(output, plan);
  input.resume();
  return new Promise((resolveResult) => {
    const onKeypress = (_value: string, key: { name?: string; ctrl?: boolean }): void => {
      if (key.name === "return") {
        input.removeListener("keypress", onKeypress);
        resolveResult(true);
      } else if (key.name === "escape" || key.name === "q" || (key.ctrl && key.name === "c")) {
        input.removeListener("keypress", onKeypress);
        resolveResult(false);
      }
    };
    input.on("keypress", onKeypress);
  });
}

export async function confirmArchivePlan(
  plan: ArchivePlan,
  input: TerminalInput = process.stdin,
  output: TerminalOutput = process.stdout,
): Promise<boolean> {
  const terminalInput = input;
  terminalInput.setRawMode(true);
  try {
    return await waitForConfirmation(terminalInput, output, plan);
  } finally {
    terminalInput.setRawMode(false);
    terminalInput.pause();
    output.write("\x1b[?25h\n");
  }
}

export async function selectUncheckedFile(
  root: string,
  input: TerminalInput = process.stdin,
  output: TerminalOutput = process.stdout,
): Promise<InteractiveSelection> {
  const scan = await discoverUncheckedFiles(root);
  if (scan.candidates.length === 0) return { cancelled: scan.errors.length === 0, errors: scan.errors };

  if (!input.isTTY) throw new Error("interactive selection requires a TTY");
  emitKeypressEvents(input as unknown as NodeJS.ReadStream);
  input.setRawMode(true);
  input.resume();
  output.write("\x1b[?25l");

  let query = "";
  let selectedIndex = 0;
  let filtered = filterCandidates(scan.candidates, query);

  return new Promise((resolveResult) => {
    const cleanup = (): void => {
      input.removeListener("keypress", onKeypress);
      input.setRawMode(false);
      input.pause();
      output.write("\x1b[?25h\n");
    };
    const finish = (result: InteractiveSelection): void => {
      cleanup();
      resolveResult(result);
    };
    const render = (): void => renderSelector(output, scan.candidates, filtered, selectedIndex, query, scan.errors.length);
    const onKeypress = (value: string, key: { name?: string; ctrl?: boolean }): void => {
      if (key.name === "up") {
        selectedIndex = filtered.length === 0 ? 0 : (selectedIndex - 1 + filtered.length) % filtered.length;
      } else if (key.name === "down") {
        selectedIndex = filtered.length === 0 ? 0 : (selectedIndex + 1) % filtered.length;
      } else if (key.name === "backspace") {
        query = query.slice(0, -1);
        filtered = filterCandidates(scan.candidates, query);
        selectedIndex = Math.min(selectedIndex, Math.max(0, filtered.length - 1));
      } else if (key.name === "return" && filtered.length > 0) {
        finish({ path: filtered[selectedIndex]!.path, cancelled: false, errors: scan.errors });
        return;
      } else if (key.name === "escape" || key.name === "q" || (key.ctrl && key.name === "c")) {
        finish({ cancelled: true, errors: scan.errors });
        return;
      } else if (!key.ctrl && value && value.length === 1 && value >= " ") {
        query += value;
        filtered = filterCandidates(scan.candidates, query);
        selectedIndex = 0;
      }
      render();
    };

    input.on("keypress", onKeypress);
    render();
  });
}