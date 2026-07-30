export type ProjectIdentity = { id: string }

export function chooseProjectId(
  projects: ProjectIdentity[],
  currentId: string | null,
  rememberedId: string | null,
  activeId: string | null,
): string | null {
  const ids = new Set(projects.map((project) => project.id))
  if (currentId && ids.has(currentId)) return currentId
  if (rememberedId && ids.has(rememberedId)) return rememberedId
  if (activeId && ids.has(activeId)) return activeId
  return projects[0]?.id ?? null
}

export function projectApi(projectId: string | null): string {
  return projectId ? `/api/projects/${encodeURIComponent(projectId)}` : ""
}
