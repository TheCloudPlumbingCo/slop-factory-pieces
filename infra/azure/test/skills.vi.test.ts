import { describe, expect, it } from 'vitest'

import { defaultSkills, skillsResponse } from '../src/Skills'

const request = (headers: Record<string, string>, query = '?deliveryId=d1') =>
	new Request(`https://broker.example/skills${query}`, { headers })

/** A fake router: the delivery check answers `status`, and remembers what it was asked. */
const router = (status: number) => {
	const seen: Array<Request> = []
	return { seen, receiver: async (r: Request) => (seen.push(r), new Response(null, { status })) }
}

describe('skillsResponse', () => {
	it('serves the default skills when the delivery accepts the token', async () => {
		const { seen, receiver } = router(200)
		const response = await skillsResponse(request({ authorization: 'Bearer t' }), receiver, undefined)
		expect(response.status).toBe(200)
		expect(await response.json()).toEqual(defaultSkills)
		expect(seen[0]!.url).toBe('https://broker.example/deliveries/d1')
		expect(seen[0]!.headers.get('authorization')).toBe('Bearer t')
	})

	it('serves the configured skills instead of the default', async () => {
		const { receiver } = router(200)
		const configured = [{ name: 'a', description: 'b', body: 'c' }]
		const response = await skillsResponse(request({ authorization: 'Bearer t' }), receiver, JSON.stringify(configured))
		expect(await response.json()).toEqual(configured)
	})

	it('answers 401 when the delivery rejects the token', async () => {
		const { receiver } = router(401)
		const response = await skillsResponse(request({ authorization: 'Bearer wrong' }), receiver, undefined)
		expect(response.status).toBe(401)
	})

	it('answers 401 without a token or a delivery id, without asking the router', async () => {
		const { seen, receiver } = router(200)
		expect((await skillsResponse(request({}), receiver, undefined)).status).toBe(401)
		expect((await skillsResponse(request({ authorization: 'Bearer t' }, ''), receiver, undefined)).status).toBe(401)
		expect(seen).toEqual([])
	})

	it('answers 500 when SKILLS_JSON is not JSON', async () => {
		const { receiver } = router(200)
		const response = await skillsResponse(request({ authorization: 'Bearer t' }), receiver, '{nope')
		expect(response.status).toBe(500)
	})
})
