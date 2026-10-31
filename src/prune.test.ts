import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pruneDuplicateUncheckedFiles } from "./prune.ts";

const source = (name: string, version: string, author: string) =>
  `/**\n * @name "${name}"\n * @version "${version}"\n * @author "${author}"\n */\nconst privateBody = true;`;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "lx-prune-"));
  const checked = join(root, "checked");
  const unchecked = join(root, "unchecked");
  await mkdir(checked, { recursive: true });
  await mkdir(unchecked, { recursive: true });
  return { checked, unchecked };
}

describe("unchecked duplicate pruning", () => {
  test("replaces checked with a newer unchecked version", async () => {
    const paths = await fixture();
    const checkedPath = join(paths.checked, "nested", "checked.js");
    const uncheckedPath = join(paths.unchecked, "incoming.js");
    await mkdir(join(paths.checked, "nested"), { recursive: true });
    await writeFile(checkedPath, source("Demo", "1", "Author"));
    await writeFile(uncheckedPath, source("Demo", "2", "Author"));

    const result = await pruneDuplicateUncheckedFiles({ checkedRoot: paths.checked, uncheckedRoot: paths.unchecked });
    expect(result.updated).toEqual([uncheckedPath]);
    expect(result.deleted).toEqual([]);
    await expect(stat(uncheckedPath)).rejects.toThrow();
    expect(await readFile(join(paths.checked, "nested", "incoming.js"), "utf8")).toContain("@version \"2\"");
    await expect(stat(checkedPath)).rejects.toThrow();
  });

  test("deletes unchecked when its version is equal or lower", async () => {
    const paths = await fixture();
    const checkedPath = join(paths.checked, "checked.js");
    const sameVersion = join(paths.unchecked, "same.js");
    const lowerVersion = join(paths.unchecked, "lower.js");
    await writeFile(checkedPath, source("Demo", "2.3.5", "Author"));
    await writeFile(sameVersion, source("Demo", "2.3.5", "Author"));
    await writeFile(lowerVersion, source("Demo", "2.3.0", "Author"));

    const result = await pruneDuplicateUncheckedFiles({ checkedRoot: paths.checked, uncheckedRoot: paths.unchecked });
    expect(result.updated).toEqual([]);
    expect(result.deleted).toEqual([lowerVersion, sameVersion]);
    expect(await readFile(checkedPath, "utf8")).toContain("@version \"2.3.5\"");
  });

  test("keeps files with different author and invalid metadata", async () => {
    const paths = await fixture();
    const differentAuthor = join(paths.unchecked, "different.js");
    const invalid = join(paths.unchecked, "invalid.js");
    await writeFile(join(paths.checked, "checked.js"), source("Demo", "1", "Author"));
    await writeFile(differentAuthor, source("Demo", "1", "Other"));
    await writeFile(invalid, "private invalid content");

    const result = await pruneDuplicateUncheckedFiles({ checkedRoot: paths.checked, uncheckedRoot: paths.unchecked });
    expect(result.deleted).toEqual([]);
    expect(result.kept).toContain(differentAuthor);
    expect(await readFile(invalid, "utf8")).toBe("private invalid content");
    expect(result.errors.join(" ")).not.toContain("private invalid content");
  });

  test("keeps files when checked matches are ambiguous", async () => {
    const paths = await fixture();
    const uncheckedPath = join(paths.unchecked, "incoming.js");
    await mkdir(join(paths.checked, "a"), { recursive: true });
    await mkdir(join(paths.checked, "b"), { recursive: true });
    await writeFile(join(paths.checked, "a", "first.js"), source("Demo", "1", "Author"));
    await writeFile(join(paths.checked, "b", "second.js"), source("Demo", "2", "Author"));
    await writeFile(uncheckedPath, source("Demo", "3", "Author"));

    const result = await pruneDuplicateUncheckedFiles({ checkedRoot: paths.checked, uncheckedRoot: paths.unchecked });
    expect(result.deleted).toEqual([]);
    expect(result.kept).toEqual([uncheckedPath]);
    await expect(stat(uncheckedPath)).resolves.toBeDefined();
    expect(result.errors.length).toBeGreaterThan(0);
  });
});
