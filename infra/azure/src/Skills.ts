/** One skill the runner installs before research: a folder `.github/skills/<name>/SKILL.md`. */
export interface Skill {
	readonly name: string
	readonly description: string
	readonly body: string
}

/** The skills served when `SKILLS_JSON` is not set: the one the spike's first stage had hard-coded. */
export const defaultSkills: ReadonlyArray<Skill> = [
	{
		name: 'research-style',
		description: 'How to write research findings for this repo. Use for any research task.',
		body: 'Write findings as a short markdown report: a one-line answer first, then a bullet list of evidence. Every claim cites a file path and line, like `src/queue.js:12`. End with a line that says `Skill used: research-style`.',
	},
]

/** The skills list as a response: `skillsJson` when set, else `defaultSkills`; 500 when the JSON is bad. */
export const skillsListResponse = (skillsJson: string | undefined): Response => {
	let skills: ReadonlyArray<Skill>
	try {
		skills = skillsJson === undefined ? defaultSkills : (JSON.parse(skillsJson) as ReadonlyArray<Skill>)
	} catch {
		return new Response('SKILLS_JSON is not valid JSON', { status: 500 })
	}
	return new Response(JSON.stringify(skills), { status: 200, headers: { 'content-type': 'application/json' } })
}

/**
 * Serve the skills list to a runner. The caller proves itself with the delivery's own access token: the request must
 * carry `Authorization: Bearer <token>` and `?deliveryId=<id>`, and the delivery API must accept that token for that
 * delivery. Without it the answer is 401, so only a task the broker handed off can read the list.
 *
 * @param receiver - the broker's router (the delivery API lives on it)
 * @param skillsJson - a JSON array of skills; `undefined` serves `defaultSkills`
 */
export const skillsResponse = async (
	request: Request,
	receiver: (request: Request) => Promise<Response>,
	skillsJson: string | undefined,
): Promise<Response> => {
	const url = new URL(request.url)
	const deliveryId = url.searchParams.get('deliveryId')
	const authorization = request.headers.get('authorization')
	if (deliveryId === null || authorization === null) return new Response('Unauthorized', { status: 401 })
	const check = await receiver(
		new Request(`${url.origin}/deliveries/${encodeURIComponent(deliveryId)}`, {
			method: 'GET',
			headers: { authorization },
		}),
	)
	if (check.status !== 200) return new Response('Unauthorized', { status: 401 })
	let skills: ReadonlyArray<Skill>
	try {
		skills = skillsJson === undefined ? defaultSkills : (JSON.parse(skillsJson) as ReadonlyArray<Skill>)
	} catch {
		return new Response('SKILLS_JSON is not valid JSON', { status: 500 })
	}
	return new Response(JSON.stringify(skills), { status: 200, headers: { 'content-type': 'application/json' } })
}
