import { NextResponse } from "next/server";
import { parseProvider, settingsRedirect } from "@/lib/connect-route";
import { beginAuthorization, STATE_TTL_MS, stateCookieName } from "@/lib/oauth-state";
import { clientCreds, isLive, publicOrigin } from "@/lib/providers/config";
import { githubMode } from "@/lib/githubMode";
import * as github from "@/lib/providers/github";
import * as jira from "@/lib/providers/jira";
import { callerOid } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ provider: string }> }) {
  const provider = parseProvider((await params).provider);
  if (!provider) return new Response("Unknown provider", { status: 404 });
  const origin = publicOrigin(req);
  const oid = await callerOid();
  if (!oid) return new Response("Sign in first", { status: 401 });
  const creds = clientCreds(provider);
  if (!creds || !isLive(provider)) return settingsRedirect(origin, "error", "not_configured");

  const redirectUri = `${origin}/api/connect/${provider}/callback`;
  const { state, challenge, cookie } = beginAuthorization(provider, oid);
  const target = provider === "github" ? github.authorizeUrl(creds, redirectUri, state, challenge, githubMode() ?? "app") : jira.authorizeUrl(creds, redirectUri, state);

  const res = NextResponse.redirect(target, 302);
  res.cookies.set(stateCookieName(provider), cookie, {
    httpOnly: true,
    secure: origin.startsWith("https://"),
    sameSite: "lax", // must survive the top-level redirect back from the provider
    path: `/api/connect/${provider}`,
    maxAge: STATE_TTL_MS / 1000,
  });
  return res;
}
