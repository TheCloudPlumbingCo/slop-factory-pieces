import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { open, seal } from "@/lib/crypto";
import type { Provider } from "@/lib/tokens";

// The pending authorization lives in an encrypted (so tamper-proof and opaque) HTTP-only
// cookie. It binds the random `state` and PKCE verifier to the Entra user who started it.

export const STATE_TTL_MS = 10 * 60 * 1000;
export const stateCookieName = (p: Provider) => `slop_oauth_${p}`;

type Pending = { provider: Provider; oid: string; state: string; verifier: string; exp: number };

export class StateError extends Error {}

const b64url = (b: Buffer) => b.toString("base64url");

export function beginAuthorization(provider: Provider, oid: string, now = Date.now()) {
  const pending: Pending = {
    provider,
    oid,
    state: b64url(randomBytes(24)),
    verifier: b64url(randomBytes(32)),
    exp: now + STATE_TTL_MS,
  };
  return {
    state: pending.state,
    verifier: pending.verifier,
    challenge: b64url(createHash("sha256").update(pending.verifier).digest()),
    cookie: seal(JSON.stringify(pending), "oauth-state"),
  };
}

export function completeAuthorization(
  cookie: string | undefined,
  expect: { provider: Provider; oid: string; state: string | null },
  now = Date.now(),
): { verifier: string } {
  if (!cookie) throw new StateError("missing_state_cookie");
  if (!expect.state) throw new StateError("missing_state");
  let pending: Pending;
  try {
    pending = JSON.parse(open(cookie, "oauth-state"));
  } catch {
    throw new StateError("invalid_state_cookie");
  }
  if (pending.exp < now) throw new StateError("expired_state");
  if (pending.provider !== expect.provider) throw new StateError("wrong_provider");
  if (pending.oid !== expect.oid) throw new StateError("wrong_user");
  const a = Buffer.from(pending.state);
  const b = Buffer.from(expect.state);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new StateError("state_mismatch");
  return { verifier: pending.verifier };
}
