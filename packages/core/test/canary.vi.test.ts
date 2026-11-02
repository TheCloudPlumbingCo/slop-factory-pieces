import { describe, expect, it } from '@effect/vitest'
import { DeliveryId } from '@humanlayer/channels-delivery'
import { Effect, Option } from 'effect'

import { parseCommand } from '../src/channels/JiraCommand'

describe('core canary', () => {
	it.effect('resolves the shared libraries and parses a command', () =>
		Effect.sync(() => {
			expect(DeliveryId).toBeDefined()
			expect(parseCommand('/research x')).toEqual(Option.some({ name: 'research', args: 'x' }))
		}),
	)
})
