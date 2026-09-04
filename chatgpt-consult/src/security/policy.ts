import { normalize } from "node:path";

export type PathDecision =
  | { kind: "allow" }
  | { kind: "deny"; reason: string };

export const DEFAULT_DENIED_TREE_COMPONENTS = Object.freeze([
  ".git",
  ".chatgpt-consult",
  "node_modules",
  ".pnpm-store",
  ".bun",
  "dist",
  "build",
  "coverage",
  ".next",
  ".cache",
  "browser-profile",
  "chrome-profile",
  "firefox-profile",
]);
const deniedComponents = new Set<string>(DEFAULT_DENIED_TREE_COMPONENTS);

const deniedNames = new Set(["id_rsa", "id_ed25519", "credentials"]);
const deniedExtensions = new Set([".pem", ".key", ".p12", ".pfx", ".kdbx"]);

const normalizedComponents = (relativePath: string): string[] =>
  normalize(relativePath).replaceAll("\\", "/").split("/").filter(Boolean);

export const classifyPath = (relativePath: string): PathDecision => {
  const components = normalizedComponents(relativePath);

  for (const component of components) {
    const name = component.toLowerCase();
    if (name.startsWith(".env")) {
      return { kind: "deny", reason: "environment files are excluded" };
    }
    if (deniedComponents.has(name)) {
      return { kind: "deny", reason: `excluded path component: ${component}` };
    }
  }

  const filename = components.at(-1)?.toLowerCase();
  if (!filename) return { kind: "allow" };
  if (deniedNames.has(filename)) {
    return { kind: "deny", reason: `credential filename: ${filename}` };
  }
  if ([...deniedExtensions].some((extension) => filename.endsWith(extension))) {
    return { kind: "deny", reason: "credential file extension" };
  }

  return { kind: "allow" };
};
