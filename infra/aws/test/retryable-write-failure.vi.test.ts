import { TransactionConflictException } from '@aws-sdk/client-dynamodb'
import { it } from '@effect/vitest'

import { isRetryableWriteFailure } from '../src/DynamoMailboxTable'

// DynamoDB Local does not reliably raise TransactionConflictException, so the classifier is pinned directly.
it.describe('isRetryableWriteFailure', () => {
	it('treats a transaction conflict on a plain Put as retryable', ({ expect }) => {
		const error = new TransactionConflictException({ message: 'in progress', $metadata: {} })
		expect(isRetryableWriteFailure(error)).toBe(true)
	})

	it('treats a failed condition as retryable', ({ expect }) => {
		const error = Object.assign(new Error('failed'), { name: 'ConditionalCheckFailedException' })
		expect(isRetryableWriteFailure(error)).toBe(true)
	})

	it('does not treat a validation error as retryable', ({ expect }) => {
		const error = Object.assign(new Error('too big'), { name: 'ValidationException' })
		expect(isRetryableWriteFailure(error)).toBe(false)
	})
})
