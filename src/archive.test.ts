import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createArchivePlan, executeArchivePlan } from "./archive.ts";
import { scanCheckedDirectory } from "./scanner.ts";

const source = (name: string, version: string, author: string, body: string) =>
  `/**\n * @name "${name}"\n * @version '${version}'\n * @author "${author}"\n */\n${body}`;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "lx-source-"));
  const checked = join(root, "checked");
  const unchecked = join(root, "unchecked");
  await mkdir(checked, { recursive: true });
  await mkdir(unchecked, { recursive: true });
  return { root, checked, unchecked };
}

describe("source archive", () => {
  test("replaces a nested match and preserves the incoming filename", async () => {
    const paths = await fixture();
    const oldPath = join(paths.checked, "quality", "old.ts");
    const newPath = join(paths.unchecked, "new.ts");
    const finalPath = join(paths.checked, "quality", "new.ts");
    await mkdir(join(paths.checked, "quality"), { recursive: true });
    await writeFile(oldPath, source("Demo", "1.2.2", "Author", "old body"));
    await writeFile(newPath, source("Demo", "1.2.5", "Author", "new body"));

    const plan = await createArchivePlan({ sourcePath: newPath, checkedRoot: paths.checked, uncheckedRoot: paths.unchecked });
    expect(plan.action).toBe("replace");
    expect(plan.matchStatus).toBe("update");
    expect(plan.targetPath).toBe(finalPath);
    await executeArchivePlan(plan);
    expect(await readFile(finalPath, "utf8")).toContain("new body");
    expect(await readFile(finalPath, "utf8")).toContain("1.2.5");
    await expect(stat(oldPath)).rejects.toThrow();
    await expect(stat(newPath)).rejects.toThrow();
  });

  test("allows replacing even when the incoming version is lower", async () => {
    const paths = await fixture();
    const oldPath = join(paths.checked, "old.ts");
    const newPath = join(paths.unchecked, "new.ts");
    await writeFile(oldPath, source("Demo", "2.0.0", "Author", "old body"));
    await writeFile(newPath, source("Demo", "1.0.0", "Author", "new body"));

    const plan = await createArchivePlan({ sourcePath: newPath, checkedRoot: paths.checked, uncheckedRoot: paths.unchecked });
    expect(plan.matchStatus).toBe("lower");
    await executeArchivePlan(plan);
    expect(await readFile(join(paths.checked, "new.ts"), "utf8")).toContain("new body");
    await expect(stat(oldPath)).rejects.toThrow();
  });

  test("moves an unmatched source to the checked root", async () => {
    const paths = await fixture();
    const sourcePath = join(paths.unchecked, "special name.ts");
    await writeFile(sourcePath, source("Unique", "3", "作者", "unchanged body"));

    const plan = await createArchivePlan({ sourcePath, checkedRoot: paths.checked, uncheckedRoot: paths.unchecked });
    expect(plan.action).toBe("move");
    await executeArchivePlan(plan);
    expect(await readFile(join(paths.checked, "special name.ts"), "utf8")).toContain("unchanged body");
    await expect(stat(sourcePath)).rejects.toThrow();
  });

  test("dry-run does not create or remove files", async () => {
    const paths = await fixture();
    const sourcePath = join(paths.unchecked, "preview.ts");
    await writeFile(sourcePath, source("Preview", "1", "Author", "body"));

    const plan = await createArchivePlan({ sourcePath, checkedRoot: paths.checked, uncheckedRoot: paths.unchecked, dryRun: true });
    await executeArchivePlan(plan, true);
    expect(await readFile(sourcePath, "utf8")).toContain("body");
    await expect(stat(join(paths.checked, "preview.ts"))).rejects.toThrow();
  });

  test("reports duplicate matches without changing the source", async () => {
    const paths = await fixture();
    const sourcePath = join(paths.unchecked, "duplicate.ts");
    await mkdir(join(paths.checked, "a"), { recursive: true });
    await mkdir(join(paths.checked, "b"), { recursive: true });
    await writeFile(join(paths.checked, "a", "one.ts"), source("Same", "1", "Author", "one"));
    await writeFile(join(paths.checked, "b", "two.ts"), source("Same", "2", "Author", "two"));
    await writeFile(sourcePath, source("Same", "3", "Author", "new"));

    const plan = await createArchivePlan({ sourcePath, checkedRoot: paths.checked, uncheckedRoot: paths.unchecked });
    expect(plan.action).toBe("error");
    await expect(executeArchivePlan(plan)).rejects.toThrow(/multiple/);
    expect(await readFile(sourcePath, "utf8")).toContain("new");
  });

  test("skips checked files without a leading JSDoc", async () => {
    const paths = await fixture();
    await writeFile(join(paths.checked, "notes.js"), "private body without metadata");

    const result = await scanCheckedDirectory(paths.checked);
    expect(result.sources).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  test("scans nested files and reports invalid ordinary files without exposing content", async () => {
    const paths = await fixture();
    await mkdir(join(paths.checked, "nested"), { recursive: true });
    await writeFile(join(paths.checked, "nested", "valid.ts"), source("Valid", "1", "Author", "secret body"));
    await writeFile(join(paths.checked, "notes.txt"), "/**\n * @name 'Invalid'\n */\nprivate invalid content");

    const result = await scanCheckedDirectory(paths.checked);
    expect(result.sources).toHaveLength(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).not.toContain("private invalid content");
  });
});
