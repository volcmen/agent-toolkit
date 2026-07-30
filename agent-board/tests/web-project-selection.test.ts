import { describe, expect, test } from "bun:test";
import { chooseProjectId, projectApi } from "../web/src/lib/project-selection.ts";

const projects = [{ id: "alpha" }, { id: "beta space" }];

describe("dashboard project selection", () => {
  test("keeps a valid current selection before remembered or active projects", () => {
    expect(chooseProjectId(projects, "beta space", "alpha", "alpha")).toBe("beta space");
  });

  test("falls back through remembered, active, first, then empty", () => {
    expect(chooseProjectId(projects, "missing", "beta space", "alpha")).toBe("beta space");
    expect(chooseProjectId(projects, "missing", "missing", "alpha")).toBe("alpha");
    expect(chooseProjectId(projects, "missing", "missing", "missing")).toBe("alpha");
    expect(chooseProjectId([], null, null, null)).toBeNull();
  });

  test("builds an encoded project-scoped API prefix", () => {
    expect(projectApi("beta space")).toBe("/api/projects/beta%20space");
    expect(projectApi(null)).toBe("");
  });
});
