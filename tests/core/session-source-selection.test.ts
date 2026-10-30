import { describe, expect, it } from "vitest";
import {
  findRouteGroup,
  selectSessionSource,
} from "../../src/core/harness-provider-selection";
import {
  type PublicSettings,
  defaultPublicSettings,
} from "../../src/shared/schemas";

// Runs, queued inputs and manual compaction share this one priority rule.
const settings = {
  ...defaultPublicSettings,
  activeSourceId: "active",
  providerSources: [
    { id: "a", label: "A", baseUrl: "https://a.test/v1", model: "only-a" },
    { id: "b", label: "B", baseUrl: "https://b.test/v1", model: "shared" },
    { id: "c", label: "C", baseUrl: "https://c.test/v1", model: "shared" },
  ],
  routeGroups: [{ id: "g", label: "G", strategy: "order", members: [] }],
} as unknown as PublicSettings;

describe("selectSessionSource", () => {
  it("prefers explicit source, then the session's pinned source", () => {
    expect(
      selectSessionSource(
        settings,
        { providerSourceId: "b" },
        {
          providerSourceId: "c",
        },
      ),
    ).toEqual({ providerSourceId: "c", routeGroupId: undefined });
    expect(
      selectSessionSource(
        settings,
        { providerSourceId: "b" },
        {
          model: "only-a",
        },
      ).providerSourceId,
    ).toBe("b");
  });
  it("lets an unambiguous model pick the source, else the active fallback", () => {
    expect(selectSessionSource(settings, {}, { model: "only-a" })).toEqual({
      providerSourceId: "a",
      routeGroupId: undefined,
    });
    expect(
      selectSessionSource(settings, {}, { model: "shared" }).providerSourceId,
    ).toBe("active");
  });
  it("keeps the session route group only when no model or source is named", () => {
    const session = { providerSourceId: "b", routeGroupId: "g" };
    // Compaction passes no input and so keeps the session's own binding.
    expect(selectSessionSource(settings, session)).toEqual({
      providerSourceId: "b",
      routeGroupId: "g",
    });
    expect(
      selectSessionSource(settings, session, { model: "shared" }).routeGroupId,
    ).toBeUndefined();
    expect(
      selectSessionSource(settings, session, { providerSourceId: "c" })
        .routeGroupId,
    ).toBeUndefined();
    expect(
      selectSessionSource(settings, session, {
        model: "shared",
        routeGroupId: "g",
      }).routeGroupId,
    ).toBe("g");
  });
});

describe("findRouteGroup", () => {
  it("returns nothing without an ID and fails on a stale one", () => {
    expect(findRouteGroup(settings, undefined)).toBeUndefined();
    expect(findRouteGroup(settings, "g")?.id).toBe("g");
    expect(() => findRouteGroup(settings, "gone")).toThrow(/路由组已不可用/);
  });
});
