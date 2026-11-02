/**
 * An in-memory stand-in for a Cosmos container with partition key `/pk`, behaving as Cosmos does where the table
 * depends on it: an etag that changes on every write, a transactional batch inside one partition that applies all
 * or nothing, and the statuses Cosmos reports (201/200 ok, 404 missing, 409 exists, 412 etag mismatch, 424 for the
 * operations of a batch that rolled back because another failed).
 */
import type { BatchOperation, CosmosItems } from '../../src/CosmosMailboxTable'

type Stored = { readonly resource: Record<string, unknown>; readonly etag: string }

export interface FakeCosmos extends CosmosItems {
	/** Every stored item of one partition, by id. */
	readonly items: (pk: string) => ReadonlyMap<string, Record<string, unknown>>
}

export const makeFakeCosmos = (): FakeCosmos => {
	const partitions = new Map<string, Map<string, Stored>>()
	let etags = 0
	const partition = (pk: string) => {
		const existing = partitions.get(pk)
		if (existing !== undefined) return existing
		const created = new Map<string, Stored>()
		partitions.set(pk, created)
		return created
	}
	const nextEtag = () => `"etag-${++etags}"`

	return {
		items: (pk) => new Map([...partition(pk)].map(([id, stored]) => [id, stored.resource])),
		read: async (id, pk) => partition(pk).get(id),
		upsert: async (item) => {
			partition(item.pk as string).set(item.id as string, { resource: item, etag: nextEtag() })
		},
		remove: async (id, pk) => {
			partition(pk).delete(id)
		},
		removeIfMatch: async (id, pk, etag) => {
			const current = partition(pk).get(id)
			if (current === undefined || current.etag !== etag) return false
			partition(pk).delete(id)
			return true
		},
		due: async (now) =>
			[...partitions.entries()].flatMap(([pk, items]) => {
				const state = items.get('state')?.resource
				return state !== undefined && state.due === true && (state.dueAt as number) <= now ? [pk] : []
			}),
		batch: async (operations: ReadonlyArray<BatchOperation>, pk) => {
			const items = partition(pk)
			const staged = new Map(items)
			const statuses: Array<number> = []
			let failed = false
			for (const operation of operations) {
				if (failed) {
					statuses.push(424)
					continue
				}
				const id = operation.operationType === 'Create' ? (operation.resourceBody.id as string) : operation.id
				const current = staged.get(id)
				if (operation.operationType === 'Create') {
					if (current !== undefined) {
						failed = true
						statuses.push(409)
						continue
					}
					staged.set(id, { resource: operation.resourceBody, etag: nextEtag() })
					statuses.push(201)
				} else {
					if (current === undefined) {
						failed = true
						statuses.push(404)
						continue
					}
					if (current.etag !== operation.ifMatch) {
						failed = true
						statuses.push(412)
						continue
					}
					staged.set(id, { resource: operation.resourceBody, etag: nextEtag() })
					statuses.push(200)
				}
			}
			if (failed) {
				// The failing operation keeps its own status; the ones before it roll back as 424, as in Cosmos.
				const firstFailure = statuses.findIndex((status) => status >= 400 && status !== 424)
				return statuses.map((status, index) => (index < firstFailure ? 424 : status))
			}
			items.clear()
			for (const [key, value] of staged) items.set(key, value)
			return statuses
		},
	}
}
