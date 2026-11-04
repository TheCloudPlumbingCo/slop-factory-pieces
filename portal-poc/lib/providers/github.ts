import { getJson } from "@/lib/upstream";
import type { TokenRecord } from "@/lib/tokens";
import type { ClientCreds } from "@/lib/providers/config";
import type { GithubMode } from "@/lib/githubMode";

// Two ways in, chosen by GITHUB_AUTH_MODE (see lib/githubMode.ts):
//  app:   GitHub App user-to-server OAuth (PKCE S256), expiring tokens, repos from the installations
//  oauth: classic OAuth App, scope "read:user repo", tokens never expire, repos from /user/repos
const API = "https://api.github.com";
const GH_HEADERS = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };

export type Repo = { fullName: string; private: boolean };

export function authorizeUrl(c: ClientCreds, redirectUri: string, state: string, challenge: string, mode: GithubMode = "app"): string {
  const u = new URL("https://github.com/login/oauth/authorize");
  const params: Record<string, string> = { client_id: c.clientId, redirect_uri: redirectUri, state };
  if (mode === "oauth") params.scope = "read:user repo";
  else Object.assign(params, { code_challenge: challenge, code_challenge_method: "S256" });
  u.search = new URLSearchParams(params).toString();
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

export const exchangeCode = (
  c: ClientCreds,
  code: string,
  redirectUri: string,
  verifier: string,
  mode: GithubMode = "app",
  now = Date.now(),
) =>
  tokenRequest(
    {
      client_id: c.clientId,
      client_secret: c.clientSecret,
      code,
      redirect_uri: redirectUri,
      ...(mode === "app" ? { code_verifier: verifier } : {}),
    },
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

const sorted = (repos: Repo[]) => repos.sort((a, b) => a.fullName.localeCompare(b.fullName));

// OAuth App token with the `repo` scope: every repo the user can access.
async function listUserRepos(token: string): Promise<Repo[]> {
  const rs = await pages<{ full_name: string; private: boolean }>(
    `${API}/user/repos?affiliation=owner,collaborator,organization_member&sort=full_name`,
    token,
    (b) => b,
  );
  return sorted(rs.map((r) => ({ fullName: r.full_name, private: r.private })));
}

export async function listRepos(token: string, mode: GithubMode = "app"): Promise<Repo[]> {
  if (mode === "oauth") return listUserRepos(token);
  // A GitHub App user token reaches the repos of the installations the user can access.
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
  return sorted(repos);
}

/** A pull request that is waiting for the signed-in person's review. */
export type ReviewRequest = { number: number; title: string; url: string; repo: string; updatedAt: string; key: string | null };

const JIRA_KEY = /\b[A-Z][A-Z0-9]+-\d+\b/;

/**
 * Open pull requests where this person's review is requested. Approvals are pull requests, so this is the real
 * "needs my attention" list. `org` limits the search to one organisation; without it every repo the token can see counts.
 * The Jira key is read from the title, then the body, when there is one.
 */
export async function listReviewRequests(token: string, org?: string): Promise<ReviewRequest[]> {
  const q = ["is:pr", "is:open", "review-requested:@me", ...(org ? [`org:${org}`] : [])].join(" ");
  const params = new URLSearchParams({ q, sort: "updated", order: "desc", per_page: "50" });
  const body = await getJson<{ items: { number: number; title: string; html_url: string; repository_url: string; updated_at: string; body?: string | null }[] }>(
    `${API}/search/issues?${params}`,
    token,
    "GitHub review requests",
    GH_HEADERS,
  );
  return body.items.map((i) => ({
    number: i.number,
    title: i.title,
    url: i.html_url,
    repo: i.repository_url.replace(`${API}/repos/`, ""),
    updatedAt: i.updated_at,
    key: JIRA_KEY.exec(i.title)?.[0] ?? JIRA_KEY.exec(i.body ?? "")?.[0] ?? null,
  }));
}
