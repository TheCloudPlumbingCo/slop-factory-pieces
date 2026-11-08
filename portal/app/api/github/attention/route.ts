import { withProviderToken } from "@/lib/data-route";
import { listReviewRequests } from "@/lib/providers/github";

export const dynamic = "force-dynamic";

// ATTENTION_ORG (optional) limits the list to one GitHub organisation.
export const GET = () => withProviderToken("github", (token) => listReviewRequests(token, process.env.ATTENTION_ORG?.trim() || undefined));
