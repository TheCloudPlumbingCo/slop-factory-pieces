import { defineConfig } from 'vitest/config'

export default defineConfig({
	test: {
		include: ['test/**/*.test.ts'],
		/**
		 * Over DynamoDB Local the control-layer suite does real I/O for every poll: B7 and B8 poll a 10-minute
		 * hand-off timeout every 100 ms of test time, which takes about 5 s of real time.
		 */
		testTimeout: 30_000,
	},
})
