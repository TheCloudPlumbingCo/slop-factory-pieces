import NextAuth, { customFetch } from "next-auth";
import MicrosoftEntraID from "next-auth/providers/microsoft-entra-id";
import type { Provider } from "next-auth/providers";
import { ManagedIdentityCredential } from "@azure/identity";

// Two ways to prove "I am slop-portal-poc" to Entra at the token step:
//  - local dev: client secret from .env.local (Auth.js default)
//  - Azure:     AZURE_MI_CLIENT_ID set -> send the managed identity's token as a
//               client assertion (federated credential on the app registration). No secret.
const miClientId = process.env.AZURE_MI_CLIENT_ID;

async function managedIdentityAssertion(): Promise<string> {
  const token = await new ManagedIdentityCredential({ clientId: miClientId }).getToken(
    "api://AzureADTokenExchange/.default",
  );
  return token.token;
}

function provider(): Provider {
  if (!miClientId) return MicrosoftEntraID; // secret mode, reads AUTH_MICROSOFT_ENTRA_ID_*

  const base = MicrosoftEntraID({ client: { token_endpoint_auth_method: "none" } });
  return {
    ...base,
    async [customFetch](...args: Parameters<typeof fetch>) {
      const [input, init] = args;
      const req = input instanceof Request ? input : undefined;
      const url = new URL(req ? req.url : String(input));
      const method = (req?.method ?? init?.method ?? "GET").toUpperCase();
      if (method === "POST" && url.pathname.endsWith("/oauth2/v2.0/token")) {
        const body = new URLSearchParams(String(init?.body ?? (await req?.clone().text()) ?? ""));
        body.set("client_assertion_type", "urn:ietf:params:oauth:client-assertion-type:jwt-bearer");
        body.set("client_assertion", await managedIdentityAssertion());
        console.log("[auth] token request sent with managed-identity client assertion");
        const headers = new Headers(init?.headers ?? req?.headers);
        headers.set("content-type", "application/x-www-form-urlencoded");
        return fetch(url, { method: "POST", headers, body });
      }
      return (base as any)[customFetch](...args);
    },
  } as unknown as Provider;
}

declare module "next-auth" {
  interface Session {
    oid?: string; // Entra object id: the key for stored connections
    tid?: string; // Entra tenant id
  }
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [provider()],
  callbacks: {
    // Keep the raw ID-token claims (tid, oid, groups, roles) visible on the page.
    jwt({ token, profile }) {
      if (profile) token.claims = profile;
      return token;
    },
    session({ session, token }) {
      const claims = (token.claims ?? {}) as { oid?: string; tid?: string };
      (session as any).claims = token.claims;
      session.oid = claims.oid;
      session.tid = claims.tid;
      return session;
    },
  },
});
