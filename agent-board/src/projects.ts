import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { CONFIG_FILE, loadConfig } from "./config.ts";

export type BoardProject = {
  id: string;
  name: string;
  root: string;
  workdir: string;
  addedAt: string;
};

type RegistryFile = {
  version: 1;
  projects: BoardProject[];
};

export const DEFAULT_DASHBOARD_PORT = 4_337;

export function projectsFile(): string {
  return process.env.AB_PROJECTS_FILE
    ? resolve(process.env.AB_PROJECTS_FILE)
    : join(homedir(), ".config", "agent-board", "projects.json");
}

function canonicalRoot(root: string): string {
  const absolute = resolve(root);
  return existsSync(absolute) ? realpathSync(absolute) : absolute;
}

function projectId(root: string): string {
  const slug = basename(root)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32) || "board";
  const digest = createHash("sha256").update(root).digest("hex").slice(0, 8);
  return `${slug}-${digest}`;
}

function projectFromRoot(root: string, addedAt = new Date().toISOString()): BoardProject {
  const canonical = canonicalRoot(root);
  if (!existsSync(join(canonical, CONFIG_FILE))) {
    throw new Error(`no agent board at ${canonical} — run \`ab init ${canonical}\` first`);
  }
  const config = loadConfig(canonical);
  return {
    id: projectId(canonical),
    name: config.name,
    root: canonical,
    workdir: config.workdir,
    addedAt,
  };
}

function readRegistry(file = projectsFile()): RegistryFile {
  if (!existsSync(file)) return { version: 1, projects: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`invalid project registry ${file}: ${(error as Error).message}`);
  }
  if (
    typeof parsed !== "object"
    || parsed === null
    || (parsed as { version?: unknown }).version !== 1
    || !Array.isArray((parsed as { projects?: unknown }).projects)
  ) {
    throw new Error(`invalid project registry ${file}: expected version 1 with a projects array`);
  }
  const projects = (parsed as RegistryFile).projects.filter((project) =>
    project
    && typeof project.id === "string"
    && typeof project.name === "string"
    && typeof project.root === "string"
    && typeof project.workdir === "string"
    && typeof project.addedAt === "string"
  );
  return { version: 1, projects };
}

function writeRegistry(registry: RegistryFile, file = projectsFile()): void {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(registry, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, file);
}

export function listProjects(currentRoot?: string): BoardProject[] {
  const registered = readRegistry().projects;
  const usable: BoardProject[] = [];
  for (const project of registered) {
    try {
      usable.push(projectFromRoot(project.root, project.addedAt));
    } catch {
      // Keep stale entries out of the live UI; `ab projects` reports them separately.
    }
  }
  if (currentRoot) {
    const current = projectFromRoot(currentRoot);
    if (!usable.some((project) => project.root === current.root)) usable.unshift(current);
  }
  return usable.sort((a, b) => a.name.localeCompare(b.name) || a.root.localeCompare(b.root));
}

export function allProjectEntries(): BoardProject[] {
  return readRegistry().projects;
}

export function registerProject(root: string): BoardProject {
  const next = projectFromRoot(root);
  const registry = readRegistry();
  const existing = registry.projects.find((project) => canonicalRoot(project.root) === next.root);
  if (existing) {
    const refreshed = { ...next, addedAt: existing.addedAt };
    registry.projects = registry.projects.map((project) => project.id === existing.id ? refreshed : project);
    writeRegistry(registry);
    return refreshed;
  }
  registry.projects.push(next);
  writeRegistry(registry);
  return next;
}

export function unregisterProject(idOrRoot: string): BoardProject {
  const registry = readRegistry();
  const resolved = resolve(idOrRoot);
  const index = registry.projects.findIndex((project) =>
    project.id === idOrRoot || project.root === resolved
  );
  if (index < 0) throw new Error(`no registered project matches ${idOrRoot}`);
  const [removed] = registry.projects.splice(index, 1);
  writeRegistry(registry);
  return removed as BoardProject;
}
