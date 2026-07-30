/**
 * Minimal YAML frontmatter for card files. Dependency-free on purpose: cards
 * only ever carry scalars, string arrays, and one level of string maps, so a
 * full YAML engine would be a dependency with no payoff.
 */

export type FmValue = string | number | boolean | null | string[] | Record<string, string>;
export type Frontmatter = Record<string, FmValue>;

const FENCE = "---";

function parseScalar(raw: string): string | number | boolean | null {
  const value = raw.trim();
  if (value === "" || value === "null" || value === "~") return null;
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  // Double-quoted scalars are written with JSON.stringify, so they must be read
  // back the same way: a handoff is several lines, and leaving `\n` as two
  // literal characters is what every downstream card would then be handed.
  if (value.startsWith('"') && value.endsWith('"') && value.length > 1) {
    try {
      const decoded = JSON.parse(value) as unknown;
      if (typeof decoded === "string") return decoded;
    } catch {
      // Not JSON-shaped after all; fall through to the raw slice.
    }
    return value.slice(1, -1);
  }
  if (value.startsWith("'") && value.endsWith("'") && value.length > 1) {
    return value.slice(1, -1);
  }
  return value;
}

function parseInlineList(raw: string): string[] {
  const inner = raw.trim().slice(1, -1).trim();
  if (!inner) return [];
  return inner
    .split(",")
    .map((item) => String(parseScalar(item) ?? ""))
    .filter((item) => item !== "");
}

/** Split a document into frontmatter and body. Body keeps its own newlines. */
export function parseDocument(text: string): { data: Frontmatter; body: string } {
  if (!text.startsWith(FENCE)) return { data: {}, body: text };
  const end = text.indexOf(`\n${FENCE}`, FENCE.length);
  if (end === -1) return { data: {}, body: text };
  const head = text.slice(FENCE.length, end);
  const rest = text.slice(end + FENCE.length + 1);
  return { data: parseFrontmatter(head), body: rest.replace(/^\r?\n/, "") };
}

export function parseFrontmatter(head: string): Frontmatter {
  const data: Frontmatter = {};
  const lines = head.split("\n");
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    index += 1;
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const match = /^([A-Za-z0-9_.-]+):\s?(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1] as string;
    const raw = (match[2] ?? "").trim();

    if (raw.startsWith("[") && raw.endsWith("]")) {
      data[key] = parseInlineList(raw);
      continue;
    }
    if (raw === "") {
      // Block list (`- item`) or block map (`  k: v`) on the following lines.
      const items: string[] = [];
      const map: Record<string, string> = {};
      while (index < lines.length) {
        const next = lines[index] ?? "";
        if (/^\s+-\s+/.test(next)) {
          items.push(String(parseScalar(next.replace(/^\s+-\s+/, "")) ?? ""));
          index += 1;
          continue;
        }
        const nested = /^\s+([A-Za-z0-9_.-]+):\s?(.*)$/.exec(next);
        if (nested) {
          map[nested[1] as string] = String(parseScalar(nested[2] ?? "") ?? "");
          index += 1;
          continue;
        }
        break;
      }
      if (items.length) data[key] = items;
      else if (Object.keys(map).length) data[key] = map;
      else data[key] = null;
      continue;
    }
    data[key] = parseScalar(raw);
  }
  return data;
}

function needsQuotes(value: string): boolean {
  return (
    value === "" ||
    // A raw newline would end the line and silently truncate the value on the
    // way back in — quoting turns it into an escape the parser can decode.
    /[\n\r\t]/.test(value) ||
    /^[-?:,[\]{}#&*!|>'"%@`]/.test(value) ||
    /:\s/.test(value) ||
    value.trim() !== value ||
    /^(true|false|null|~)$/i.test(value) ||
    /^-?\d+(\.\d+)?$/.test(value)
  );
}

function serializeScalar(value: string | number | boolean): string {
  if (typeof value !== "string") return String(value);
  return needsQuotes(value) ? JSON.stringify(value) : value;
}

export function serializeFrontmatter(data: Frontmatter): string {
  const out: string[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (value === null || value === undefined) continue;
    if (Array.isArray(value)) {
      if (value.length === 0) {
        out.push(`${key}: []`);
        continue;
      }
      out.push(`${key}:`);
      for (const item of value) out.push(`  - ${serializeScalar(item)}`);
      continue;
    }
    if (typeof value === "object") {
      const entries = Object.entries(value);
      if (entries.length === 0) continue;
      out.push(`${key}:`);
      for (const [k, v] of entries) out.push(`  ${k}: ${serializeScalar(v)}`);
      continue;
    }
    out.push(`${key}: ${serializeScalar(value)}`);
  }
  return out.join("\n");
}

export function serializeDocument(data: Frontmatter, body: string): string {
  const head = serializeFrontmatter(data);
  const trimmed = body.replace(/^\r?\n+/, "").replace(/\s+$/, "");
  return `${FENCE}\n${head}\n${FENCE}\n\n${trimmed}\n`;
}
