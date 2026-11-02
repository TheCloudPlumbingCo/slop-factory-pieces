import { BulkOperationType, type Container, type JSONObject, type OperationInput } from '@azure/cosmos'

import type { BatchOperation, CosmosItems } from './CosmosMailboxTable'

const isNotFound = (error: unknown) => typeof error === 'object' && error !== null && 'code' in error && error.code === 404

const toSdk = (operation: BatchOperation): OperationInput =>
	operation.operationType === 'Create'
		? { operationType: BulkOperationType.Create, resourceBody: operation.resourceBody as JSONObject }
		: {
				operationType: BulkOperationType.Replace,
				id: operation.id,
				resourceBody: operation.resourceBody as JSONObject,
				ifMatch: operation.ifMatch,
			}

/**
 * Adapts the Azure SDK's container to `CosmosItems`.
 *
 * @param container - a container with partition key `/pk`
 */
export const fromCosmosContainer = (container: Container): CosmosItems => ({
	read: async (id, pk) => {
		const result = await container.item(id, pk).read<Record<string, unknown>>()
		if (result.resource === undefined) return undefined
		return { resource: result.resource, etag: result.etag }
	},
	batch: async (operations, pk) => {
		const response = await container.items.batch(operations.map(toSdk), pk)
		return (response.result ?? []).map((entry) => entry.statusCode)
	},
	upsert: async (item) => {
		await container.items.upsert(item)
	},
	remove: async (id, pk) => {
		try {
			await container.item(id, pk).delete()
		} catch (error) {
			if (!isNotFound(error)) throw error
		}
	},
	removeIfMatch: async (id, pk, etag) => {
		try {
			await container.item(id, pk).delete({ accessCondition: { type: 'IfMatch', condition: etag } })
			return true
		} catch (error) {
			if (isNotFound(error) || (typeof error === 'object' && error !== null && 'code' in error && error.code === 412)) {
				return false
			}
			throw error
		}
	},
	due: async (now) => {
		const { resources } = await container.items
			.query<{ pk: string }>({
				query: "SELECT c.pk FROM c WHERE c.id = 'state' AND c.due = true AND c.dueAt <= @now",
				parameters: [{ name: '@now', value: now }],
			})
			.fetchAll()
		return resources.map((row) => row.pk)
	},
})
