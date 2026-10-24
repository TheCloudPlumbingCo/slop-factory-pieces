/**
 * Bundles each Lambda entry in `src/lambda/` into one self-contained CommonJS file in `dist/`, with every
 * dependency inlined, so the zip needs no `node_modules`. CommonJS because the zip carries no `package.json`, and
 * Lambda treats a plain `.js` file as CommonJS.
 */
import { build } from 'esbuild'

const entries = ['receiver', 'processor', 'sweep'] as const

await Promise.all(
	entries.map((name) =>
		build({
			entryPoints: [`src/lambda/${name}.ts`],
			outfile: `dist/${name}.js`,
			bundle: true,
			platform: 'node',
			target: 'node22',
			format: 'cjs',
			minify: true,
			sourcemap: 'linked',
			logLevel: 'info',
		}),
	),
)
