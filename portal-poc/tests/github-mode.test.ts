import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotConnectedError, accessTokenFor } from "@/lib/connections";
import { githubMode } from "@/lib/githubMode";
import { authorizeUrl, exchangeCode, listRepos } from "@/lib/providers/github";
import { MemoryStore, jsonResponse, useTestKey } from "./helpers";

const creds = { clientId: "cid", clientSecret: "sec" };

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.GITHUB_AUTH_MODE;
});
beforeEach(useTestKey);

describe("GITHUB_AUTH_MODE", () => {
  it("defaults to app, accepts app and oauth, rejects anything else", () => {
    expect(githubMode(undefined)).toBe("app");
    expect(githubMode("OAuth ")).toBe("oauth");
    expect(githubMode("app")).toBe("app");
    expect(githubMode("pat")).toBeNull();
    expect(githubMode("")).toBeNull();
  });
});

describe("authorizeUrl", () => {
  it("app mode sends PKCE and no scope", () => {
    const u = new URL(authorizeUrl(creds, "https://x/cb", "st", "ch", "app"));
    expect(u.searchParams.get("code_challenge")).toBe("ch");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.has("scope")).toBe(false);
  });
  it("oauth mode asks for read:user repo and sends no PKCE", () => {
    const u = new URL(authorizeUrl(creds, "https://x/cb", "st", "ch", "oauth"));
    expect(u.searchParams.get("scope")).toBe("read:user repo");
    expect(u.searchParams.has("code_challenge")).toBe(false);
    expect(u.searchParams.get("state")).toBe("st");
  });
});

describe("exchangeCode", () => {
  const capture = () => {
    let body = new URLSearchParams();
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init: RequestInit) => {
      body = new URLSearchParams(String(init.body));
      return jsonResponse({ access_token: "gho_x" });
    }));
    return () => body;
  };
  it("app mode sends the code verifier", async () => {
    const body = capture();
    await exchangeCode(creds, "code", "https://x/cb", "ver", "app");
    expect(body().get("code_verifier")).toBe("ver");
  });
  it("oauth mode omits the verifier and returns a token that never expires", async () => {
    const body = capture();
    const t = await exchangeCode(creds, "code", "https://x/cb", "ver", "oauth");
    expect(body().has("code_verifier")).toBe(false);
    expect(t.expiresAt).toBeUndefined();
    expect(t.refreshToken).toBeUndefined();
  });
});

describe("listRepos in oauth mode", () => {
  it("pages through /user/repos and sorts by name", async () => {
    const repo = (n: number) => ({ full_name: `acme/r${String(n).padStart(3, "0")}`, private: n % 2 === 0 });
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      urls.push(url);
      const u = new URL(url);
      expect(u.pathname).toBe("/user/repos");
      expect(u.searchParams.get("affiliation")).toBe("owner,collaborator,organization_member");
      const page = Number(u.searchParams.get("page"));
      const from = (page - 1) * 100;
      return jsonResponse(Array.from({ length: page === 1 ? 100 : 3 }, (_, i) => repo(from + i)).reverse());
    }));
    const result = await listRepos("tok", "oauth");
    expect(result).toHaveLength(103);
    expect(result[0].fullName).toBe("acme/r000");
    expect(urls).toHaveLength(2);
  });
});

describe("a connection made under another mode", () => {
  it("is not usable after the flag changes", async () => {
    const store = new MemoryStore();
    await store.put("oid1", "github", { accessToken: "t", account: "@a", mode: "app" });

    process.env.GITHUB_AUTH_MODE = "app";
    await expect(accessTokenFor("oid1", "github", store)).resolves.toBe("t");

    process.env.GITHUB_AUTH_MODE = "oauth";
    await expect(accessTokenFor("oid1", "github", store)).rejects.toBeInstanceOf(NotConnectedError);
  });
});
