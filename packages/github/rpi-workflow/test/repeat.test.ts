/** The repeat guard: check-repeat.sh reads the marker that publish.sh writes. */
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeEach, describe, expect, it } from 'vitest'

const scripts = join(import.meta.dirname, '..', 'scripts')

const run = (script: string, env: Record<string, string>, cwd: string) =>
	spawnSync('bash', [join(scripts, script)], {
		cwd,
		env: { PATH: process.env.PATH ?? '', HOME: cwd, ...env },
		encoding: 'utf8',
	})

let root: string
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'rpi-repeat-'))
})

describe('check-repeat.sh', () => {
	/** A fake `gh api` that prints the comment bodies we give it, or fails. */
	const setup = (bodies: string | null) => {
		const bin = join(root, 'bin')
		mkdirSync(bin)
		const log = join(root, 'gh.log')
		const script =
			bodies === null
				? `#!/usr/bin/env bash\necho "$*" >> "${log}"\nexit 1\n`
				: `#!/usr/bin/env bash\necho "$*" >> "${log}"\ncat <<'BODIES'\n${bodies}\nBODIES\n`
		writeFileSync(join(bin, 'gh'), script)
		chmodSync(join(bin, 'gh'), 0o755)
		const output = join(root, 'output')
		writeFileSync(output, '')
		return { bin, log, output }
	}

	const check = (s: ReturnType<typeof setup>, env: Record<string, string> = {}) =>
		run(
			'check-repeat.sh',
			{
				PATH: `${s.bin}:${process.env.PATH ?? ''}`,
				RUN_ID: 'delivery:v1:abc',
				ISSUE: '42',
				GITHUB_REPOSITORY: 'acme/ws',
				GITHUB_OUTPUT: s.output,
				...env,
			},
			root,
		)

	it('skips when a bot comment holds the run id marker', () => {
		const s = setup('Research is done.\n\n<!-- slopfactory-run:delivery:v1:abc -->')
		const r = check(s)
		expect(r.status, r.stderr).toBe(0)
		expect(readFileSync(s.output, 'utf8')).toContain('skip=true')
		expect(readFileSync(s.log, 'utf8')).toContain('repos/acme/ws/issues/42/comments')
		expect(readFileSync(s.log, 'utf8')).toContain('select(.user.type == "Bot")')
	})

	it('runs when only another run id is marked', () => {
		const s = setup('Research is done.\n\n<!-- slopfactory-run:delivery:v1:other -->')
		const r = check(s)
		expect(r.status).toBe(0)
		expect(readFileSync(s.output, 'utf8')).toContain('skip=false')
	})

	it('runs when the run id is empty, and does not call GitHub', () => {
		const s = setup('<!-- slopfactory-run: -->')
		const r = check(s, { RUN_ID: '' })
		expect(r.status).toBe(0)
		expect(readFileSync(s.output, 'utf8')).toContain('skip=false')
		expect(existsSync(s.log)).toBe(false)
	})

	it('runs, with a warning, when the comments cannot be read', () => {
		const s = setup(null)
		const r = check(s)
		expect(r.status).toBe(0)
		expect(readFileSync(s.output, 'utf8')).toContain('skip=false')
		expect(r.stdout).toContain('Could not read')
	})

	it('does not treat the run id as a pattern', () => {
		const s = setup('<!-- slopfactory-run:delivery.v1.abc -->')
		const r = check(s, { RUN_ID: 'delivery:v1:abc' })
		expect(r.status).toBe(0)
		expect(readFileSync(s.output, 'utf8')).toContain('skip=false')
	})
})

describe('publish.sh run marker', () => {
	const setup = () => {
		const bin = join(root, 'bin')
		mkdirSync(bin)
		const tmp = join(root, 'tmp')
		mkdirSync(tmp)
		writeFileSync(join(tmp, 'status'), 'fail\n')
		writeFileSync(join(tmp, 'result.md'), 'It failed.\n')
		const posted = join(root, 'posted.md')
		writeFileSync(
			join(bin, 'gh'),
			`#!/usr/bin/env bash
prev=""
if [ "$1" = issue ]; then for a in "$@"; do if [ "$prev" = --body-file ]; then cp "$a" "${posted}"; fi; prev="$a"; done; fi
`,
		)
		chmodSync(join(bin, 'gh'), 0o755)
		return { bin, tmp, posted }
	}

	const publish = (s: ReturnType<typeof setup>, runId: string) =>
		run(
			'publish.sh',
			{
				PATH: `${s.bin}:${process.env.PATH ?? ''}`,
				WS: 'be',
				ISSUE: '42',
				WORKSPACE_DIR: join(root, 'workspace'),
				PUBLISH_TOKEN: 'tok',
				DEFAULT_BRANCH: 'main',
				RUNNER_TEMP: s.tmp,
				GITHUB_REPOSITORY: 'acme/ws',
				RUN_ID: runId,
			},
			root,
		)

	it('ends the issue comment with the run id marker', () => {
		const s = setup()
		expect(publish(s, 'delivery:v1:abc').status).toBe(0)
		const posted = readFileSync(s.posted, 'utf8')
		expect(posted).toContain('It failed.')
		expect(posted.trimEnd().endsWith('<!-- slopfactory-run:delivery:v1:abc -->')).toBe(true)
	})

	it('adds no marker without a run id', () => {
		const s = setup()
		expect(publish(s, '').status).toBe(0)
		expect(readFileSync(s.posted, 'utf8')).not.toContain('slopfactory-run')
	})
})
