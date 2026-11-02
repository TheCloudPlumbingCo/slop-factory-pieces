import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotConnectedError, accessTokenFor } from "@/lib/connections";
import { buildJql, searchIssues } from "@/lib/providers/jira";
import { MemoryStore, jsonResponse } from "./helpers";

beforeEach(() => {
  process.env.ATLASSIAN_CLIENT_ID = "cid";
  process.env.ATLASSIAN_CLIENT_SECRET = "csecret";
});
afterEach(() => vi.unstubAllGlobals());

describe("searchIssues", () => {
  it("resolves the cloudId, calls the JQL search endpoint and maps issues", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      urls.push(url);
      if (url.endsWith("/oauth/token/accessible-resources")) return jsonResponse([{ id: "cloud-1", url: "https://acme.atlassian.net", name: "acme" }]);
      return jsonResponse({ issues: [{ key: "PAY-1", fields: { summary: "Fix checkout" } }] });
    }));

    const out = await searchIssues("tok", "checkout");
    expect(out).toEqual([{ key: "PAY-1", title: "Fix checkout", url: "https://acme.atlassian.net/browse/PAY-1" }]);
    const search = new URL(urls[1]);
    expect(search.origin + search.pathname).toBe("https://api.atlassian.com/ex/jira/cloud-1/rest/api/3/search/jql");
    expect(search.searchParams.get("maxResults")).toBe("50");
    expect(search.searchParams.get("jql")).toContain('summary ~ "checkout*"');
  });

  it("returns nothing when the user has no accessible site", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse([])));
    expect(await searchIssues("tok", "x")).toEqual([]);
  });
});

describe("buildJql", () => {
  it("strips JQL-significant characters and adds a key clause for issue keys", () => {
    expect(buildJql('a" OR 1=1')).toBe('(summary ~ "a OR 1 1*") ORDER BY updated DESC');
    expect(buildJql("pay-12")).toContain('key = "PAY-12"');
    expect(buildJql("")).toBe("updated >= -90d ORDER BY updated DESC");
  });
});

describe("accessTokenFor", () => {
  const now = 1_000_000;

  it("returns a still-valid token without refreshing", async () => {
    const store = new MemoryStore();
    await store.put("o", "jira", { accessToken: "old", refreshToken: "r", expiresAt: now + 10 * 60_000, account: "a" });
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    expect(await accessTokenFor("o", "jira", store, now)).toBe("old");
    expect(f).not.toHaveBeenCalled();
  });

  it("refreshes an expired token and stores the rotated refresh token", async () => {
    const store = new MemoryStore();
    await store.put("o", "jira", { accessToken: "old", refreshToken: "r1", expiresAt: now - 1, account: "a" });
    const f = vi.fn(async (_url: string, init: RequestInit) => {
      expect(JSON.parse(String(init.body))).toMatchObject({ grant_type: "refresh_token", refresh_token: "r1", client_id: "cid", client_secret: "csecret" });
      return jsonResponse({ access_token: "new", refresh_token: "r2", expires_in: 3600 });
    });
    vi.stubGlobal("fetch", f);

    expect(await accessTokenFor("o", "jira", store, now)).toBe("new");
    expect(await store.get("o", "jira")).toEqual({ accessToken: "new", refreshToken: "r2", expiresAt: now + 3_600_000, account: "a" });
  });

  it("drops the connection and asks to reconnect when refresh is rejected", async () => {
    const store = new MemoryStore();
    await store.put("o", "jira", { accessToken: "old", refreshToken: "r1", expiresAt: now - 1, account: "a" });
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: "invalid_grant" }, 403)));
    await expect(accessTokenFor("o", "jira", store, now)).rejects.toBeInstanceOf(NotConnectedError);
    expect(await store.get("o", "jira")).toBeNull();
  });

  it("reports not connected when nothing is stored", async () => {
    await expect(accessTokenFor("o", "jira", new MemoryStore(), now)).rejects.toBeInstanceOf(NotConnectedError);
  });
});
