import { withProviderToken } from "@/lib/data-route";
import { githubMode } from "@/lib/githubMode";
import { listRepos } from "@/lib/providers/github";

export const dynamic = "force-dynamic";

export const GET = () => withProviderToken("github", (token) => listRepos(token, githubMode() ?? "app"));
