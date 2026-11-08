import { providers, type Provider } from "@/lib/tokens";

export const parseProvider = (s: string): Provider | null => (providers as string[]).includes(s) ? (s as Provider) : null;

// Relative redirect target on the Settings page, e.g. /settings?error=state_mismatch
export const settingsRedirect = (origin: string, key: "connected" | "error", value: string) =>
  Response.redirect(`${origin}/settings?${key}=${encodeURIComponent(value)}`, 302);
