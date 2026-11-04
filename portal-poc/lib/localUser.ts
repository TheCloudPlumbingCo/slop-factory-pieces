// Local development without Microsoft sign-in: PORTAL_LOCAL_USER=<name> makes every request that person, while the
// GitHub and Jira connections stay real. It is ignored on Azure (AZURE_MI_CLIENT_ID is set there), so it cannot
// switch sign-in off on the deployed app by accident.
export function localUser(env: Record<string, string | undefined> = process.env): string | null {
  if (env.AZURE_MI_CLIENT_ID) return null;
  return env.PORTAL_LOCAL_USER?.trim() || null;
}

/** The key stored connections are filed under for the local user. */
export const localOid = (name: string) => `local:${name}`;
