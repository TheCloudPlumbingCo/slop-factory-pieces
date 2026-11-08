import type { CosmosItems } from './CosmosMailboxTable'

/** How long a dispatched workflow has to trade its OIDC token for the task password. */
export const PENDING_TTL_SECONDS = 15 * 60

/**
 * What the broker remembers between dispatching a research workflow and the runner's token exchange. `accessToken` is
 * the delivery's task password.
 */
export interface PendingResearch {
	readonly deliveryId: string
	/** The numeric GitHub repository id, as a string; the OIDC `repository_id` claim must equal it. */
	readonly repositoryId: string
	readonly installationId: string
	readonly accessToken: string
	/** Epoch ms; checked on read because Cosmos removes expired items lazily. */
	readonly expiresAt: number
}

export interface PendingResearchStore {
	readonly save: (record: PendingResearch) => Promise<void>
	/** The record, without consuming it; `undefined` when unknown or expired. */
	readonly peek: (deliveryId: string, nowMs: number) => Promise<PendingResearch | undefined>
	/** Consume the record; true for exactly one caller even when several race. */
	readonly take: (deliveryId: string) => Promise<boolean>
}

/** Works in tests and for a single process; `nowMs` of `peek` decides expiry. */
export const makeMemoryPendingResearch = (): PendingResearchStore => {
	const records = new Map<string, PendingResearch>()
	return {
		save: async (record) => void records.set(record.deliveryId, record),
		peek: async (deliveryId, nowMs) => {
			const record = records.get(deliveryId)
			return record !== undefined && record.expiresAt > nowMs ? record : undefined
		},
		take: async (deliveryId) => records.delete(deliveryId),
	}
}

/**
 * One partition for every pending record: the exchange route knows only the delivery id, not the mailbox, and a
 * point read needs the partition key. Records live 15 minutes, so the partition stays tiny; the cost is that all
 * pending records share one logical partition's throughput, fine for a spike.
 */
export const PENDING_PARTITION = 'pending-research'

const itemId = (deliveryId: string) => `research:${deliveryId}`

/** Pending records in the mailbox container, each with its own `ttl` (the container's default ttl is -1). */
export const makeCosmosPendingResearch = (items: CosmosItems): PendingResearchStore => ({
	save: (record) =>
		items.upsert({ ...record, id: itemId(record.deliveryId), pk: PENDING_PARTITION, ttl: PENDING_TTL_SECONDS }),
	peek: async (deliveryId, nowMs) => {
		const found = await items.read(itemId(deliveryId), PENDING_PARTITION)
		if (found === undefined) return undefined
		const { deliveryId: id, repositoryId, installationId, accessToken, expiresAt } = found.resource as unknown as PendingResearch
		return expiresAt > nowMs ? { deliveryId: id, repositoryId, installationId, accessToken, expiresAt } : undefined
	},
	// An etag-guarded delete: of two racing exchanges only one wins.
	take: async (deliveryId) => {
		const found = await items.read(itemId(deliveryId), PENDING_PARTITION)
		if (found === undefined) return false
		return items.removeIfMatch(itemId(deliveryId), PENDING_PARTITION, found.etag)
	},
})
