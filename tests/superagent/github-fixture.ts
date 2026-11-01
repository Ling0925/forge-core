import type { Delivery } from "../../src/shared";

export const timestamp = "2026-10-31T12:00:00Z";
export const issue = {
  id: 101,
  number: 1,
  title: "Investigate the fixture",
  body: "Context",
  html_url: "https://github.com/owner/repo/issues/1",
  state: "open",
  user: { login: "contributor" },
  created_at: timestamp,
  updated_at: timestamp,
};
export const comment = {
  id: 201,
  body: "@forge-bot please investigate",
  user: { login: "contributor" },
  created_at: timestamp,
  updated_at: timestamp,
};
export const payload = {
  action: "created",
  repository: { full_name: "owner/repo" },
  sender: { login: "contributor" },
  issue,
  comment,
};
export const delivery = (patch: Partial<Delivery> = {}): Delivery => ({
  id: "delivery-1",
  event: "issue_comment",
  receivedAt: timestamp,
  processedAt: null,
  payload,
  ...patch,
});
