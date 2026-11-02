import { afterEach, describe, expect, it, vi } from "vitest";
import { listRepos } from "@/lib/providers/github";
import { jsonResponse } from "./helpers";

afterEach(() => vi.unstubAllGlobals());

const repos = (from: number, n: number) =>
  Array.from({ length: n }, (_, i) => ({ full_name: `acme/r${String(from + i).padStart(3, "0")}`, private: i % 2 === 0 }));

describe("listRepos", () => {
  it("follows pages for installations and repositories", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      seen.push(url);
      expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
      const u = new URL(url);
      const page = Number(u.searchParams.get("page"));
      if (u.pathname === "/user/installations") return jsonResponse({ installations: [{ id: 7 }] });
      expect(u.pathname).toBe("/user/installations/7/repositories");
      if (page === 1) return jsonResponse({ repositories: repos(0, 100) });
      if (page === 2) return jsonResponse({ repositories: repos(100, 100) });
      return jsonResponse({ repositories: repos(200, 5) });
    }));

    const result = await listRepos("tok");
    expect(result).toHaveLength(205);
    expect(result[0]).toEqual({ fullName: "acme/r000", private: true });
    expect(seen.filter((u) => u.includes("/repositories"))).toHaveLength(3);
  });

  it("surfaces upstream errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({}, 403)));
    await expect(listRepos("tok")).rejects.toMatchObject({ status: 403 });
  });
});
