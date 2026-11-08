import { withProviderToken } from "@/lib/data-route";
import { searchIssues } from "@/lib/providers/jira";

export const dynamic = "force-dynamic";

export const GET = (req: Request) => {
  const q = new URL(req.url).searchParams.get("q") ?? "";
  return withProviderToken("jira", (token) => searchIssues(token, q.slice(0, 100)));
};
