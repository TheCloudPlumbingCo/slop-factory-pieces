/**
 * Bundles the Functions entry (`src/functions/index.ts`) into one self-contained CommonJS file with every dependency
 * inlined, copies `app/host.json` and `app/package.json` beside it, and zips the folder to `dist/app.zip`, the file
 * Terraform's `package_path` and `az functionapp deployment source config-zip` take.
 */
import { cp, mkdir, rm } from 'node:fs/promises'

import { build } from 'esbuild'

await rm('dist', { recursive: true, force: true })
await mkdir('dist/app', { recursive: true })

await build({
	entryPoints: ['src/functions/index.ts'],
	outfile: 'dist/app/index.js',
	bundle: true,
	// The Functions host supplies this module at runtime; it is not on disk to bundle.
	external: ['@azure/functions-core'],
	platform: 'node',
	target: 'node22',
	format: 'cjs',
	minify: true,
	sourcemap: 'linked',
	logLevel: 'info',
})

await cp('app/host.json', 'dist/app/host.json')
await cp('app/package.json', 'dist/app/package.json')

// Only the .js is zipped; the source map stays local.
const zip = Bun.spawnSync(['zip', '-q', '../app.zip', 'index.js', 'host.json', 'package.json'], { cwd: 'dist/app' })
if (zip.exitCode !== 0) throw new Error(`zip failed: ${zip.stderr.toString()}`)
