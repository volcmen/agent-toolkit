import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_FILE, defaultConfig } from "../src/config.ts";
import { registerProject } from "../src/projects.ts";
import { seedPrompts } from "../src/prompts.ts";
import { seedRoles } from "../src/roles.ts";
import { createServer } from "../src/server.ts";
import { Store } from "../src/store.ts";

const timeout = 30_000;
let fixture = "";
let alpha = "";
let beta = "";
let gamma = "";
let server: ReturnType<typeof createServer>;
let previousRegistry: string | undefined;
let betaProjectId = "";

function seedBoard(root: string, name: string, cardTitle: string): void {
  const store = new Store(root);
  store.ensureDirs();
  seedRoles(root);
  seedPrompts(root);
  writeFileSync(join(root, CONFIG_FILE), JSON.stringify({ ...defaultConfig(root), name }), "utf8");
  store.create({
    title: cardTitle,
    body: `${cardTitle} specification`,
    role: "generalist",
    status: "ready",
  });
}

async function waitForText(view: Bun.WebView, wanted: string, waitMs = 5_000): Promise<void> {
  await view.evaluate(`new Promise((resolve, reject) => {
    const deadline = Date.now() + ${waitMs};
    const poll = () => {
      if (document.body.textContent.includes(${JSON.stringify(wanted)})) return resolve(true);
      if (Date.now() > deadline) {
        return reject(new Error("Timed out waiting for " + ${JSON.stringify(wanted)}));
      }
      setTimeout(poll, 25);
    };
    poll();
  })`);
}

async function markByText(
  view: Bun.WebView,
  selector: string,
  text: string,
  id: string,
): Promise<void> {
  const marked = await view.evaluate(`(() => {
    const element = [...document.querySelectorAll(${JSON.stringify(selector)})]
      .find(candidate => candidate.textContent.includes(${JSON.stringify(text)}));
    if (!element) return false;
    element.id = ${JSON.stringify(id)};
    return true;
  })()`) as unknown as boolean;
  expect(marked).toBe(true);
}

async function openDashboard(): Promise<Bun.WebView> {
  const view = new Bun.WebView({ width: 1440, height: 900 });
  // Linux WebView instances can share one browser profile. Reset cross-test
  // preferences before the app boots so a project/theme chosen by one test
  // cannot change the initial board observed by the next test.
  await view.navigate(server.url);
  await view.evaluate(`(() => {
    localStorage.removeItem("ab-project");
    localStorage.removeItem("ab-theme");
    return true;
  })()`);
  await view.navigate(server.url);
  await view.evaluate(`(() => {
    window.__abTestErrors = [];
    window.addEventListener("error", event => {
      window.__abTestErrors.push(event.error?.message || event.message);
    });
    window.addEventListener("unhandledrejection", event => {
      window.__abTestErrors.push(String(event.reason));
    });
    return true;
  })()`);
  await waitForText(view, "Alpha-only card");
  return view;
}

async function expectNoPageErrors(view: Bun.WebView): Promise<void> {
  const errors = await view.evaluate(`window.__abTestErrors`) as unknown as string[];
  expect(errors).toEqual([]);
}

beforeAll(() => {
  fixture = mkdtempSync(join(tmpdir(), "ab-dashboard-browser-"));
  alpha = join(fixture, "alpha");
  beta = join(fixture, "beta");
  gamma = join(fixture, "gamma");
  previousRegistry = process.env.AB_PROJECTS_FILE;
  process.env.AB_PROJECTS_FILE = join(fixture, "projects.json");

  seedBoard(alpha, "Alpha project", "Alpha-only card");
  seedBoard(beta, "Beta project", "Beta-only card");
  seedBoard(gamma, "Gamma project", "Gamma-only card");
  registerProject(alpha);
  betaProjectId = registerProject(beta).id;
  server = createServer({ root: alpha, port: 0 });
});

afterAll(() => {
  server.stop();
  if (previousRegistry === undefined) delete process.env.AB_PROJECTS_FILE;
  else process.env.AB_PROJECTS_FILE = previousRegistry;
  rmSync(fixture, { recursive: true, force: true });
});

describe("dashboard browser workflows", () => {
  test("project menu opens and switches isolated boards", async () => {
    await using view = await openDashboard();

    await view.click('button[aria-haspopup="menu"]');
    await waitForText(view, "Switch project");
    await markByText(view, '[role="menuitem"]', "Beta project", "switch-beta-project");
    await view.click("#switch-beta-project");
    await waitForText(view, "Beta-only card");

    const state = await view.evaluate(`({
      alphaVisible: document.body.textContent.includes("Alpha-only card"),
      betaVisible: document.body.textContent.includes("Beta-only card"),
      selected: localStorage.getItem("ab-project"),
    })`) as unknown as { alphaVisible: boolean; betaVisible: boolean; selected: string };
    expect(state.alphaVisible).toBe(false);
    expect(state.betaVisible).toBe(true);
    expect(state.selected).toBe(betaProjectId);
    await expectNoPageErrors(view);
  }, timeout);

  test("dark theme toggles and survives navigation reload", async () => {
    await using view = await openDashboard();

    const startsDark = await view.evaluate(
      `document.documentElement.classList.contains("dark")`,
    ) as unknown as boolean;
    if (startsDark) {
      await view.click('button[aria-label="Use light theme"]');
      await view.evaluate(`new Promise((resolve, reject) => {
        const deadline = Date.now() + 3000;
        const poll = () => {
          if (!document.documentElement.classList.contains("dark")) return resolve(true);
          if (Date.now() > deadline) return reject(new Error("theme did not switch to light"));
          setTimeout(poll, 25);
        };
        poll();
      })`);
    }
    await view.click('button[aria-label="Use dark theme"]');
    const toggled = await view.evaluate(`({
      dark: document.documentElement.classList.contains("dark"),
      stored: localStorage.getItem("ab-theme"),
      scheme: document.documentElement.style.colorScheme,
    })`) as unknown as { dark: boolean; stored: string; scheme: string };
    expect(toggled).toEqual({ dark: true, stored: "dark", scheme: "dark" });

    await view.navigate(server.url);
    await waitForText(view, "Alpha-only card");
    const persisted = await view.evaluate(`({
      dark: document.documentElement.classList.contains("dark"),
      stored: localStorage.getItem("ab-theme"),
      hasLightToggle: Boolean(document.querySelector('button[aria-label="Use light theme"]')),
    })`) as unknown as { dark: boolean; stored: string; hasLightToggle: boolean };
    expect(persisted).toEqual({ dark: true, stored: "dark", hasLightToggle: true });
  }, timeout);

  test("keeps the sidebar fixed while the content pane scrolls", async () => {
    await using view = await openDashboard();

    const rail = await view.evaluate(`(() => {
      const element = document.querySelector('[data-testid="kanban-scroll"]');
      const style = getComputedStyle(element);
      return {
        labelled: element?.getAttribute("aria-label"),
        overflowX: style.overflowX,
        hasNestedVerticalScroll: element.scrollHeight > element.clientHeight + 1,
      };
    })()`) as unknown as {
      labelled: string;
      overflowX: string;
      hasNestedVerticalScroll: boolean;
    };
    expect(rail.labelled).toBe("Kanban board columns");
    expect(rail.overflowX).toBe("auto");
    expect(rail.hasNestedVerticalScroll).toBe(false);

    await markByText(view, "button", "Roles & souls", "scroll-roles-tab");
    await view.click("#scroll-roles-tab");
    // Anchor on the card chrome, not a role description — descriptions are the
    // routing signal and get retuned.
    await waitForText(view, "View SOUL.md");
    const before = await view.evaluate(`(() => {
      const main = document.querySelector('[data-testid="main-scroll"]');
      main.scrollTo(0, 0);
      const sidebar = document.querySelector('[data-testid="project-sidebar"]');
      return {
        scrollHeight: main.scrollHeight,
        viewportHeight: main.clientHeight,
        sidebarTop: sidebar.getBoundingClientRect().top,
        headerTop: document.querySelector("header").getBoundingClientRect().top,
      };
    })()`) as unknown as {
      scrollHeight: number;
      viewportHeight: number;
      sidebarTop: number;
      headerTop: number;
    };
    expect(before.scrollHeight).toBeGreaterThan(before.viewportHeight);

    await view.evaluate(`new Promise((resolve, reject) => {
      const main = document.querySelector('[data-testid="main-scroll"]');
      main.scrollTo(0, 300);
      const deadline = Date.now() + 3000;
      const poll = () => {
        if (main.scrollTop > 0) return resolve(true);
        if (Date.now() > deadline) return reject(new Error("content pane did not scroll"));
        requestAnimationFrame(poll);
      };
      poll();
    })`);
    const after = await view.evaluate(`(() => ({
      mainScrollTop: document.querySelector('[data-testid="main-scroll"]').scrollTop,
      windowScrollY: window.scrollY,
      sidebarTop: document.querySelector('[data-testid="project-sidebar"]').getBoundingClientRect().top,
      headerTop: document.querySelector("header").getBoundingClientRect().top,
    }))()`) as unknown as {
      mainScrollTop: number;
      windowScrollY: number;
      sidebarTop: number;
      headerTop: number;
    };
    expect(after.mainScrollTop).toBeGreaterThan(0);
    expect(after.windowScrollY).toBe(0);
    expect(after.sidebarTop).toBeCloseTo(before.sidebarTop, 0);
    expect(after.headerTop).toBeCloseTo(before.headerTop, 0);
    await expectNoPageErrors(view);
  }, timeout);

  test("creates a card and opens its project-scoped detail", async () => {
    await using view = await openDashboard();

    await markByText(view, "button", "New card", "new-card");
    await view.click("#new-card");
    await waitForText(view, "Create work");
    await view.click("#title");
    await view.type("Browser-created card");
    await view.click("#body");
    await view.type("The browser-created specification must remain on Alpha.");
    await markByText(view, "button", "Create card", "create-card");
    await view.click("#create-card");
    await waitForText(view, "Browser-created card");

    await markByText(view, "button", "Browser-created card", "open-created-card");
    await view.click("#open-created-card");
    await waitForText(view, "Assigned role");
    await waitForText(view, "The browser-created specification must remain on Alpha.");

    const card = new Store(alpha).list().find((candidate) => candidate.title === "Browser-created card");
    expect(card?.status).toBe("triage");
    expect(card?.body.trim()).toBe("The browser-created specification must remain on Alpha.");
    expect(new Store(beta).list().some((candidate) => candidate.title === "Browser-created card")).toBe(false);
    await expectNoPageErrors(view);
  }, timeout);

  test("shows role SOUL contracts and previews dispatch without launching workers", async () => {
    await using view = await openDashboard();

    await markByText(view, "button", "Roles & souls", "roles-tab");
    await view.click("#roles-tab");
    await waitForText(view, "View SOUL.md");
    await markByText(view, "button", "View SOUL.md", "view-soul");
    await view.click("#view-soul");
    await waitForText(view, "Role: backend engineer.");
    const soul = await view.evaluate(`document.body.textContent`) as unknown as string;
    expect(soul).toContain("You are a durable board worker");

    await markByText(view, 'button[data-slot="dialog-close"]', "", "close-soul");
    await view.click("#close-soul");
    await markByText(view, "button", "Board", "board-tab");
    await view.click("#board-tab");
    await markByText(view, "button", "Dispatch", "dispatch");
    await view.click("#dispatch");
    await waitForText(view, "Dispatch eligible work?");
    await waitForText(view, "Start dispatch");

    const preview = await view.evaluate(`document.body.textContent`) as unknown as string;
    expect(preview).toContain("fingerprint");
    expect(preview).toContain("eligible");
    await expectNoPageErrors(view);
  }, timeout);

  test("archives a finished card from its detail panel and reopens it from the archive", async () => {
    const store = new Store(alpha);
    const shipped = store.create({
      title: "Archivable alpha card",
      body: "Finished work that belongs in the archive.",
      role: "generalist",
      status: "done",
    });
    await using view = await openDashboard();
    await waitForText(view, "Archivable alpha card");

    await markByText(view, "button", "Archivable alpha card", "open-shipped-card");
    // The done column sits at the far end of the horizontally scrolling board.
    await view.evaluate(`(() => {
      document.getElementById("open-shipped-card").scrollIntoView({ block: "center", inline: "center" });
      return true;
    })()`);
    await view.click("#open-shipped-card");
    await waitForText(view, "Assigned role");
    await markByText(view, '[data-slot="sheet-content"] button', "Archive", "archive-card");
    await view.click("#archive-card");
    await waitForText(view, "Archived");

    expect(store.requireById(shipped.id).path).toContain(join("board", "archive"));
    expect(store.list().some((card) => card.id === shipped.id)).toBe(false);

    await markByText(view, '[data-slot="sheet-content"] button[data-slot="sheet-close"]', "", "close-shipped-card");
    await view.click("#close-shipped-card");
    await view.click('[data-testid="archive-tab"]');
    await waitForText(view, "1 archived card");
    await markByText(view, '[data-testid="archive-view"] button', "Reopen", "reopen-shipped-card");
    await view.click("#reopen-shipped-card");
    await waitForText(view, "Nothing archived yet");

    const reopened = store.requireById(shipped.id);
    expect(reopened.status).toBe("ready");
    expect(reopened.path).toContain(join("board", "cards"));
    await expectNoPageErrors(view);
  }, timeout);

  test("registers a third project and keeps its store isolated", async () => {
    await using view = await openDashboard();

    await view.click('button[aria-label="Add project"]');
    await waitForText(view, "Add project board");
    await view.click("#project-root");
    await view.type(gamma);
    await markByText(view, "button", "Register project", "register-project");
    await view.click("#register-project");
    await waitForText(view, "Gamma-only card");

    const state = await view.evaluate(`({
      gammaVisible: document.body.textContent.includes("Gamma-only card"),
      alphaVisible: document.body.textContent.includes("Alpha-only card"),
    })`) as unknown as { gammaVisible: boolean; alphaVisible: boolean };
    expect(state).toEqual({ gammaVisible: true, alphaVisible: false });
    expect(new Store(gamma).list().map((card) => card.title)).toEqual(["Gamma-only card"]);
    await expectNoPageErrors(view);
  }, timeout);
});
