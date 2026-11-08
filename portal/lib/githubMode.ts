// Feature flag: how the GitHub connection works for this whole deployment.
//   GITHUB_AUTH_MODE=app   (default) GitHub App user-to-server tokens
//   GITHUB_AUTH_MODE=oauth classic GitHub OAuth App
// No Node imports here: the client reads the info objects below.
export type GithubMode = "app" | "oauth";

export type GithubInfo = { mode: GithubMode | null; label: string; sees: string };

export const githubModeInfo: Record<GithubMode, Omit<GithubInfo, "mode">> = {
  app: { label: "GitHub App", sees: "Sees only the repos where the app is installed. Tokens expire after 8 hours and refresh on their own." },
  oauth: { label: "GitHub OAuth App", sees: "Sees every repo you can access, including private ones. The token does not expire." },
};

export function githubMode(raw = process.env.GITHUB_AUTH_MODE): GithubMode | null {
  const v = (raw ?? "app").trim().toLowerCase();
  return v === "app" || v === "oauth" ? v : null;
}
