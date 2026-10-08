import { open } from "node:fs/promises";

export const DEFAULT_HEADER_BYTES = 64 * 1024;

export interface SourceMetadata {
  name: string;
  version: string;
  author: string;
}

export interface MetadataReadResult {
  path: string;
  metadata?: SourceMetadata;
  error?: string;
}

export class MetadataError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "MetadataError";
    this.code = code;
  }
}

function cleanJSDocLine(line: string): string {
  return line.replace(/^\s*\*?\s?/, "").trim();
}

function parseFieldValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new MetadataError("empty-field", "metadata value must not be empty");
  }

  const quote = trimmed[0];
  if (quote !== "'" && quote !== '"') return trimmed;
  if (trimmed.at(-1) !== quote) {
    throw new MetadataError("invalid-field", "metadata value has invalid quotes");
  }

  const content = trimmed.slice(1, -1);
  if (content.length === 0) {
    throw new MetadataError("empty-field", "metadata value must not be empty");
  }
  return content;
}

export function parseMetadataFromHeader(header: string, sourcePath = "source"): SourceMetadata {
  const withoutBom = header.replace(/^\uFEFF/, "");
  const jsdocStart = withoutBom.search(/\/\*(?:\*|!)/);
  const firstContent = withoutBom.search(/\S/);
  if (jsdocStart < 0 || firstContent < 0 || jsdocStart !== firstContent) {
    throw new MetadataError("missing-jsdoc", `${sourcePath}: JSDoc was not found at the file start`);
  }

  const jsdocEnd = withoutBom.indexOf("*/", jsdocStart + 3);
  if (jsdocEnd < 0) {
    throw new MetadataError("unterminated-jsdoc", `${sourcePath}: JSDoc is not closed in the file header`);
  }

  const body = withoutBom.slice(jsdocStart + 3, jsdocEnd);
  const values: Partial<Record<keyof SourceMetadata, string>> = {};
  const fields = ["name", "version", "author"] as const;

  for (const rawLine of body.split(/\r?\n/)) {
    const line = cleanJSDocLine(rawLine);
    const match = /^(?:@\s*)?(name|version|author)\b(.*)$/i.exec(line);
    if (!match) continue;

    const field = match[1]!.toLowerCase() as keyof SourceMetadata;
    if (values[field] !== undefined) {
      throw new MetadataError("duplicate-field", `${sourcePath}: duplicate ${field} field`);
    }

    const remainder = match[2]!.trim().replace(/^[:=]\s*/, "");
    if (remainder.length === 0) {
      throw new MetadataError("invalid-field", `${sourcePath}: ${field} field has no value`);
    }

    try {
      values[field] = parseFieldValue(remainder);
    } catch (error) {
      const message = error instanceof MetadataError ? error.message : "invalid value";
      throw new MetadataError("invalid-field", `${sourcePath}: ${field} ${message}`);
    }
  }

  for (const field of fields) {
    if (values[field] === undefined) {
      throw new MetadataError("missing-field", `${sourcePath}: missing ${field} field`);
    }
  }

  return {
    name: values.name as string,
    version: values.version as string,
    author: values.author as string,
  };
}

export async function readMetadata(
  path: string,
  maxBytes = DEFAULT_HEADER_BYTES,
): Promise<SourceMetadata> {
  const file = await open(path, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await file.read(buffer, 0, maxBytes, 0);
    return parseMetadataFromHeader(buffer.subarray(0, bytesRead).toString("utf8"), path);
  } finally {
    await file.close();
  }
}

export async function readMetadataSafely(path: string): Promise<MetadataReadResult> {
  try {
    return { path, metadata: await readMetadata(path) };
  } catch (error) {
    const message = error instanceof MetadataError ? error.message : "file could not be read";
    return { path, error: message };
  }
}
