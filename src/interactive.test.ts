import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { tmpdir } from "node:os";
import { discoverUncheckedFiles, filterCandidates } from "./interactive.ts";
import { parseArgs, runCli } from "./cli.ts";

const source = (name: string) => `/**\n * @name "${name}"\n * @version 1.0.0\n * @author Author\n */\nconst privateBody = true;`;

describe("interactive source selection", () => {
  test("discovers valid files recursively and keeps invalid files out of candidates", async () => {
    const root = await mkdtemp(join(tmpdir(), "lx-interactive-"));
    await mkdir(join(root, "nested"), { recursive: true });
    await writeFile(join(root, "z-source.js"), source("Z"));
    await writeFile(join(root, "nested", "a-source.js"), source("A"));
    await writeFile(join(root, "invalid.js"), "/**\n * @name 'Invalid'\n * @version '1'\n */");
    await writeFile(join(root, "no-jsdoc.js"), "private body without metadata");
    await writeFile(join(root, "ignored.ts"), "not considered by the interactive selector");

    const result = await discoverUncheckedFiles(root);
    expect(result.candidates.map((candidate) => candidate.displayPath)).toEqual([
      `nested${sep}a-source.js`,
      "z-source.js",
    ]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("invalid.js");
    expect(result.errors[0]).not.toContain("private body without metadata");
  });

  test("filters only by case-insensitive filename substring", () => {
    const candidates = [
      { path: "a", fileName: "Fish-Music.js", displayPath: "Fish-Music.js", metadata: { name: "Other", version: "1", author: "A" } },
      { path: "b", fileName: "qq-source.js", displayPath: "qq-source.js", metadata: { name: "Fish", version: "1", author: "B" } },
    ];
    expect(filterCandidates(candidates, "MUSIC").map((candidate) => candidate.path)).toEqual(["a"]);
    expect(filterCandidates(candidates, "other").map((candidate) => candidate.path)).toEqual([]);
    expect(filterCandidates(candidates, "")).toHaveLength(2);
  });

  test("skips a directly specified file without a leading JSDoc", async () => {
    const root = await mkdtemp(join(tmpdir(), "lx-cli-skip-"));
    const checked = join(root, "checked");
    const unchecked = join(root, "unchecked");
    const sourcePath = join(unchecked, "plain.js");
    await mkdir(checked, { recursive: true });
    await mkdir(unchecked, { recursive: true });
    await writeFile(sourcePath, "private body without metadata");

    const output: string[] = [];
    const originalLog = console.log;
    console.log = (...values: unknown[]) => output.push(values.join(" "));
    try {
      expect(await runCli([sourcePath, "--checked", checked, "--unchecked", unchecked])).toBe(0);
    } finally {
      console.log = originalLog;
    }

    expect(JSON.parse(output.join(" "))).toMatchObject({ action: "skipped" });
  });

  test("uses interactive mode when no source path is supplied", () => {
    expect(parseArgs([]).interactive).toBe(true);
    expect(parseArgs(["--dry-run"]).interactive).toBe(true);
    expect(parseArgs(["unchecked/source.js"]).interactive).toBe(false);
  });
});
