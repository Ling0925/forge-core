import { expect, it } from "vitest";
import {
  narrowestPermission,
  permissionRank,
} from "../../src/shared/permissions";
import type { Permission } from "../../src/shared/schemas";

it("orders permissions from readonly to unrestricted", () => {
  expect(permissionRank("readonly")).toBeLessThan(permissionRank("workspace"));
  expect(permissionRank("workspace")).toBeLessThan(
    permissionRank("unrestricted"),
  );
});

it("clamps to the narrowest limit, ignoring omitted limits", () => {
  expect(narrowestPermission("unrestricted")).toBe("unrestricted");
  expect(narrowestPermission("unrestricted", undefined, "workspace")).toBe(
    "workspace",
  );
  expect(narrowestPermission("workspace", "unrestricted", undefined)).toBe(
    "workspace",
  );
  expect(narrowestPermission("unrestricted", "workspace", "readonly")).toBe(
    "readonly",
  );
});

it("fails closed for an unrecognised value", () => {
  expect(narrowestPermission("admin" as Permission)).toBe("readonly");
  expect(narrowestPermission("unrestricted", "admin" as Permission)).toBe(
    "readonly",
  );
});
