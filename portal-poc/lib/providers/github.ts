import { getJson } from "@/lib/upstream";
import type { TokenRecord } from "@/lib/tokens";
import type { ClientCreds } from "@/lib/providers/config";

// GitHub App user-to-server OAuth (web flow, PKCE S256).
const API = "https://api.github.com";
const GH_HEADERS = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };

export type Repo = { fullName: string; private: boolean };

export function authorizeUrl(c: ClientCreds, redirectUri: string, state: string, challenge: string): string {
  const u = new URL("https://github.com/login/oauth/authorize");
  u.search = new URLSearchParams({
    client_id: c.clientId,
    redirect_uri: redirectUri,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  return u.toString();
}

type TokenResponse = { access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string };

async function tokenRequest(params: Record<string, string>, now: number): Promise<Omit<TokenRecord, "account">> {
  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  const body = (await res.json().catch(() => ({}))) as TokenResponse;
  // GitHub reports OAuth errors with HTTP 200 and an `error` field.
  if (!res.ok || body.error || !body.access_token) throw new Error(`github token request rejected: ${body.error ?? res.status}`);
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt: body.expires_in ? now + body.expires_in * 1000 : undefined,
  };
}

export const exchangeCode = (c: ClientCreds, code: string, redirectUri: string, verifier: string, now = Date.now()) =>
  tokenRequest(
    { client_id: c.clientId, client_secret: c.clientSecret, code, redirect_uri: redirectUri, code_verifier: verifier },
    now,
  );

export async function refresh(c: ClientCreds, record: TokenRecord, now = Date.now()): Promise<TokenRecord> {
  if (!record.refreshToken) throw new Error("no refresh token");
  const t = await tokenRequest(
    { client_id: c.clientId, client_secret: c.clientSecret, grant_type: "refresh_token", refresh_token: record.refreshToken },
    now,
  );
  return { ...record, ...t };
}

export async function fetchAccount(token: string): Promise<string> {
  const me = await getJson<{ login: string }>(`${API}/user`, token, "GitHub /user", GH_HEADERS);
  return `@${me.login}`;
}

async function pages<T>(url: string, token: string, pick: (body: any) => T[]): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; ; page++) {
    const body = await getJson(`${url}${url.includes("?") ? "&" : "?"}per_page=100&page=${page}`, token, "GitHub list", GH_HEADERS);
    const items = pick(body);
    out.push(...items);
    if (items.length < 100) return out;
  }
}

// A GitHub App user token reaches the repos of the installations the user can access.
export async function listRepos(token: string): Promise<Repo[]> {
  const installs = await pages<{ id: number }>(`${API}/user/installations`, token, (b) => b.installations);
  const repos: Repo[] = [];
  for (const i of installs) {
    const rs = await pages<{ full_name: string; private: boolean }>(
      `${API}/user/installations/${i.id}/repositories`,
      token,
      (b) => b.repositories,
    );
    repos.push(...rs.map((r) => ({ fullName: r.full_name, private: r.private })));
  }
  return repos.sort((a, b) => a.fullName.localeCompare(b.fullName));
}
