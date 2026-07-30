/** Ids and slugs. Card ids are short, sortable-ish, and safe in filenames. */

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz"; // no i/l/o/u — avoids misreads

export function randomSuffix(length = 6): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = "";
  for (const byte of bytes) out += ALPHABET[byte % ALPHABET.length];
  return out;
}

export function cardId(): string {
  return `c_${randomSuffix(8)}`;
}

export function runId(): string {
  return `r_${randomSuffix(8)}`;
}

export function slugify(text: string, max = 48): string {
  const slug = text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
  return slug || "card";
}

/** Deterministic card filename: date + slug + id tail, stable across edits. */
export function cardFilename(id: string, title: string, createdAt: Date): string {
  const date = createdAt.toISOString().slice(0, 10);
  return `${date}-${slugify(title)}-${id.replace(/^c_/, "")}.md`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
