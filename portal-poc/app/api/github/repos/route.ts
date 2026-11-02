import { withProviderToken } from "@/lib/data-route";
import { listRepos } from "@/lib/providers/github";

export const dynamic = "force-dynamic";

export const GET = () => withProviderToken("github", listRepos);
