import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import App from "../src/App"

const projects = [
  {
    id: "alpha",
    name: "Alpha project",
    root: "/boards/alpha",
    workdir: "/work/alpha",
    active: true,
    cards: 1,
    statuses: { ready: 1 },
    running: 0,
  },
  {
    id: "beta",
    name: "Beta project",
    root: "/boards/beta",
    workdir: "/work/beta",
    active: false,
    cards: 1,
    statuses: { ready: 1 },
    running: 0,
  },
]

function board(project: "alpha" | "beta") {
  const title = project === "alpha" ? "Alpha-only card" : "Beta-only card"
  const empty = () => []
  return {
    board: `${project} project`,
    workdir: `/work/${project}`,
    readOnly: false,
    csrfToken: `${project}-csrf`,
    columns: ["triage", "todo", "ready", "running", "review", "blocked", "done"],
    cards: {
      triage: empty(),
      todo: empty(),
      ready: [{
        id: `c_${project}`,
        short: project.toUpperCase(),
        title,
        body: `${project} specification`,
        status: "ready",
        role: "generalist",
        runtime: "codex",
        model: null,
        priority: 0,
        parents: [],
        spentUsd: 0,
        tokens: 0,
        ceilingUsd: 1.5,
        leased: false,
        blockedReason: null,
        updatedAt: "2026-07-28T00:00:00.000Z",
        allowedActions: ["start", "block"],
      }],
      running: empty(),
      review: empty(),
      blocked: empty(),
      done: empty(),
    },
    roles: [{
      name: "generalist",
      runtime: "codex",
      readOnly: false,
      description: "General implementation role",
    }],
    caps: { maxRunning: 2, maxRunningPerRole: 1, tickSeconds: 30 },
    dispatching: false,
  }
}

function archive() {
  return {
    total: 1,
    limit: 100,
    cards: [{
      id: "c_shipped",
      short: "SHIPPED",
      title: "Archived alpha card",
      body: "shipped specification",
      status: "archived",
      role: "generalist",
      runtime: "codex",
      model: null,
      priority: 0,
      parents: [],
      spentUsd: 0,
      tokens: 0,
      ceilingUsd: 1.5,
      leased: false,
      blockedReason: null,
      updatedAt: "2026-07-27T00:00:00.000Z",
      allowedActions: ["reopen"],
    }],
  }
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

async function waitForText(text: string): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!document.body.textContent?.includes(text)) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${JSON.stringify(text)}`)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
  }
}

function buttonNamed(name: string): HTMLButtonElement {
  const button = [...document.querySelectorAll("button")]
    .find((candidate) => candidate.textContent?.includes(name))
  if (!(button instanceof HTMLButtonElement)) throw new Error(`No button named ${name}`)
  return button
}

describe("dashboard DOM", () => {
  let root: Root
  let container: HTMLDivElement
  const reopened: string[] = []

  beforeEach(async () => {
    localStorage.clear()
    reopened.length = 0
    document.documentElement.className = ""
    container = document.createElement("div")
    document.body.replaceChildren(container)
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === "/api/projects") {
        return response({ projects, activeProjectId: "alpha", csrfToken: "hub-csrf" })
      }
      if (url === "/api/projects/alpha/api/board") return response(board("alpha"))
      if (url === "/api/projects/beta/api/board") return response(board("beta"))
      if (url.startsWith("/api/projects/alpha/api/archive")) return response(archive())
      if (url.startsWith("/api/projects/beta/api/archive")) return response({ total: 0, limit: 100, cards: [] })
      if (url === "/api/projects/alpha/api/card/c_shipped/set") {
        reopened.push(url)
        return response({ card: { id: "c_shipped", status: "ready" } })
      }
      return response({ error: `Unexpected test request: ${url}` }, 404)
    }) as typeof fetch

    root = createRoot(container)
    await act(async () => root.render(<App />))
    await waitForText("Alpha-only card")
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    mock.restore()
  })

  test("renders project-scoped metrics, cards, and roles without spend reporting", () => {
    expect(document.body.textContent).toContain("Alpha project")
    expect(document.body.textContent).toContain("Alpha-only card")
    expect(document.body.textContent).toContain("SOUL.md contracts")
    expect(document.body.textContent).not.toContain("Tracked metered spend")
    expect(document.body.textContent).not.toContain("Tracked spend")
    expect(document.querySelector('button[aria-label="Add project"]')).toBeTruthy()
    expect(document.querySelector('[data-scroll-layout="fixed-sidebar"]')).toBeTruthy()
    expect(document.querySelector('[data-testid="project-sidebar"]')).toBeTruthy()
    expect(document.querySelector('[data-testid="main-scroll"]')).toBeTruthy()
    expect(document.querySelector('[data-testid="kanban-scroll"]')?.getAttribute("aria-label"))
      .toBe("Kanban board columns")
  })

  test("switches boards without leaking cards between projects", async () => {
    await act(async () => buttonNamed("Beta project").click())
    await waitForText("Beta-only card")

    expect(document.body.textContent).toContain("Beta-only card")
    expect(document.body.textContent).not.toContain("Alpha-only card")
    expect(localStorage.getItem("ab-project")).toBe("beta")
  })

  test("the archive tab lists archived cards and reopens them onto the board", async () => {
    expect(document.body.textContent).not.toContain("Archived alpha card")

    await act(async () => buttonNamed("Archive").click())
    await waitForText("Archived alpha card")
    expect(document.body.textContent).toContain("1 archived card")
    expect(document.querySelector('[data-testid="archive-view"]')).toBeTruthy()

    await act(async () => buttonNamed("Reopen").click())
    expect(reopened).toEqual(["/api/projects/alpha/api/card/c_shipped/set"])
  })

  test("toggles and persists dark theme state", async () => {
    const toggle = document.querySelector('button[aria-label="Use dark theme"]')
    expect(toggle).toBeInstanceOf(HTMLButtonElement)

    await act(async () => (toggle as HTMLButtonElement).click())

    expect(document.documentElement.classList.contains("dark")).toBe(true)
    expect(document.documentElement.style.colorScheme).toBe("dark")
    expect(localStorage.getItem("ab-theme")).toBe("dark")
    expect(document.querySelector('button[aria-label="Use light theme"]')).toBeTruthy()
  })
})
