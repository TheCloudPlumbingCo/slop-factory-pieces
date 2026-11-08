import { afterEach, describe, expect, it, vi } from "vitest";
import { listReviewRequests } from "@/lib/providers/github";
import { jsonResponse } from "./helpers";

afterEach(() => vi.unstubAllGlobals());

const item = (over: Record<string, unknown>) => ({
  number: 1,
  title: "Research KAN-9",
  html_url: "https://github.com/acme/ws/pull/1",
  repository_url: "https://api.github.com/repos/acme/ws",
  updated_at: "2026-11-04T10:00:00Z",
  body: null,
  ...over,
});

describe("listReviewRequests", () => {
  it("asks GitHub for open PRs awaiting the caller's review, limited to the org", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => jsonResponse({ items: [] }));
    vi.stubGlobal("fetch", fetchMock);
    await listReviewRequests("tok", "acme");
    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.pathname).toBe("/search/issues");
    expect(url.searchParams.get("q")).toBe("is:pr is:open review-requested:@me org:acme");
    expect((fetchMock.mock.calls[0][1].headers as Record<string, string>).Authorization).toBe("Bearer tok");
  });

  it("searches every visible repo when no org is given", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => jsonResponse({ items: [] }));
    vi.stubGlobal("fetch", fetchMock);
    await listReviewRequests("tok");
    expect(new URL(fetchMock.mock.calls[0][0]).searchParams.get("q")).toBe("is:pr is:open review-requested:@me");
  });

  it("maps results and reads the Jira key from the title, then the body", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ items: [
      item({}),
      item({ number: 2, title: "Plan for water temperature", body: "Refs KAN-4", html_url: "https://github.com/acme/ws/pull/2" }),
      item({ number: 3, title: "Unrelated", body: null }),
    ] })));
    const out = await listReviewRequests("tok");
    expect(out.map((r) => [r.number, r.repo, r.key])).toEqual([[1, "acme/ws", "KAN-9"], [2, "acme/ws", "KAN-4"], [3, "acme/ws", null]]);
  });

  it("surfaces upstream errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({}, 401)));
    await expect(listReviewRequests("tok")).rejects.toMatchObject({ status: 401 });
  });
});
