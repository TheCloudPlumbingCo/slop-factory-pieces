import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeEach, describe, expect, it } from 'vitest'

const scripts = join(import.meta.dirname, '..', 'scripts')

const run = (script: string, args: string[], options: { cwd: string; env?: Record<string, string> }) =>
	spawnSync('bash', [join(scripts, script), ...args], {
		cwd: options.cwd,
		env: { PATH: process.env.PATH ?? '', HOME: options.cwd, ...options.env },
		encoding: 'utf8',
	})

const git = (cwd: string, ...args: string[]) => {
	const out = spawnSync('git', args, { cwd, encoding: 'utf8' })
	if (out.status !== 0) throw new Error(`git ${args.join(' ')}: ${out.stderr}`)
	return out.stdout
}

const write = (path: string, text: string) => {
	mkdirSync(join(path, '..'), { recursive: true })
	writeFileSync(path, text)
}

let root: string
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'rpi-workflow-'))
})

describe('check-workspace.sh', () => {
	const check = (ws: string) => {
		write(join(root, 'workspace/workspaces/be/workspace.json'), '{"repos":[]}')
		mkdirSync(join(root, 'tmp'))
		const result = run('check-workspace.sh', [], {
			cwd: root,
			env: { WS: ws, WORKSPACE_DIR: join(root, 'workspace'), RUNNER_TEMP: join(root, 'tmp') },
		})
		const read = (name: string) => (existsSync(join(root, 'tmp', name)) ? readFileSync(join(root, 'tmp', name), 'utf8') : '')
		return { code: result.status, status: read('status').trim(), message: read('result.md') }
	}

	it('passes for a workspace that exists', () => {
		expect(check('be')).toEqual({ code: 0, status: '', message: '' })
	})

	it('fails for an invalid id', () => {
		const result = check('Not Valid')
		expect(result.code).toBe(1)
		expect(result.status).toBe('fail')
		expect(result.message).toContain('not a valid workspace id')
	})

	it('fails for a missing workspace and lists the ones that exist', () => {
		const result = check('ops')
		expect(result.code).toBe(1)
		expect(result.message).toContain('no workspace `ops`')
		expect(result.message).toContain('be')
	})
})

describe('guard-output.sh', () => {
	const guard = (text: string, secret?: string) => {
		const file = join(root, 'out.md')
		writeFileSync(file, text)
		return run('guard-output.sh', secret === undefined ? [file] : [file, secret], { cwd: root }).status
	}

	it('allows plain text', () => {
		expect(guard('The tea service calls water-service at src/a.ts:10.')).toBe(0)
	})

	it('blocks text that looks like a GitHub token', () => {
		expect(guard(`token ghp_${'a'.repeat(30)} here`)).toBe(1)
		expect(guard(`github_pat_${'B'.repeat(30)}`)).toBe(1)
	})

	it('blocks text holding the given secret', () => {
		expect(guard('the secret is s3cr3t-value', 's3cr3t-value')).toBe(1)
		expect(guard('nothing here', 's3cr3t-value')).toBe(0)
	})
})

describe('clone-repos.sh', () => {
	it('copies each listed repo without its .git folder', () => {
		const origins = join(root, 'origins')
		for (const name of ['core', 'tea']) {
			const repo = join(origins, 'acme', `${name}.git`)
			mkdirSync(repo, { recursive: true })
			git(repo, 'init', '-q', '-b', 'main')
			git(repo, 'config', 'user.email', 't@t')
			git(repo, 'config', 'user.name', 't')
			writeFileSync(join(repo, 'README.md'), name)
			git(repo, 'add', '.')
			git(repo, 'commit', '-q', '-m', 'init')
		}
		write(join(root, 'workspace/workspaces/be/workspace.json'), JSON.stringify({ repos: ['acme/core', 'acme/tea'] }))
		const result = run('clone-repos.sh', [], {
			cwd: root,
			env: { WS: 'be', WORKSPACE_DIR: join(root, 'workspace'), CLONE_BASE: `file://${origins}` },
		})
		expect(result.status, result.stderr).toBe(0)
		expect(readFileSync(join(root, 'repos/core/README.md'), 'utf8')).toBe('core')
		expect(readFileSync(join(root, 'repos/tea/README.md'), 'utf8')).toBe('tea')
		expect(existsSync(join(root, 'repos/core/.git'))).toBe(false)
	})
})

describe('publish.sh', () => {
	/** A workspace checkout with a local bare remote, a temp folder, and a fake `gh` that records its calls. */
	const setup = (status: 'ok' | 'fail', result: string, out?: string) => {
		const remote = join(root, 'remote.git')
		git(root, 'init', '-q', '--bare', '-b', 'main', remote)
		const dir = join(root, 'workspace')
		mkdirSync(dir)
		git(dir, 'init', '-q', '-b', 'main')
		git(dir, 'config', 'user.email', 't@t')
		git(dir, 'config', 'user.name', 't')
		git(dir, 'remote', 'add', 'origin', remote)
		writeFileSync(join(dir, 'README.md'), 'x')
		git(dir, 'add', '.')
		git(dir, 'commit', '-q', '-m', 'init')
		git(dir, 'push', '-q', 'origin', 'main')

		const tmp = join(root, 'tmp')
		mkdirSync(tmp)
		writeFileSync(join(tmp, 'status'), `${status}\n`)
		if (result !== '') writeFileSync(join(tmp, 'result.md'), result)
		if (out !== undefined) writeFileSync(join(tmp, 'out.md'), out)

		const bin = join(root, 'bin')
		mkdirSync(bin)
		const log = join(root, 'gh.log')
		writeFileSync(
			join(bin, 'gh'),
			`#!/usr/bin/env bash\necho "$*" >> "${log}"\nif [ "$1" = pr ] && [ "$2" = create ]; then echo https://github.com/acme/ws/pull/7; fi\nif [ "$1" = issue ]; then for a in "$@"; do :; done; fi\n`,
		)
		chmodSync(join(bin, 'gh'), 0o755)
		return { dir, tmp, bin, log, remote }
	}

	const publish = (s: ReturnType<typeof setup>) =>
		run('publish.sh', [], {
			cwd: root,
			env: {
				PATH: `${s.bin}:${process.env.PATH ?? ''}`,
				WS: 'be',
				ISSUE: '42',
				WORKSPACE_DIR: s.dir,
				PUBLISH_TOKEN: 'tok',
				DEFAULT_BRANCH: 'main',
				RUNNER_TEMP: s.tmp,
				GITHUB_REPOSITORY: 'acme/ws',
				GITHUB_SERVER_URL: 'https://github.com',
				GITHUB_RUN_ID: '99',
			},
		})

	it('on success pushes a research branch, opens a PR, and comments with the PR link', () => {
		const s = setup('ok', 'The answer.\n', 'The answer.\n')
		const result = publish(s)
		expect(result.status, result.stderr).toBe(0)
		expect(git(s.remote, 'branch', '--list', 'be/research/issue-42')).toContain('be/research/issue-42')
		expect(git(s.remote, 'show', 'be/research/issue-42:workspaces/be/research/issue-42.md')).toContain('The answer.')
		const calls = readFileSync(s.log, 'utf8')
		expect(calls).toContain('pr create --base main --head be/research/issue-42')
		expect(calls).toContain('issue comment 42 --repo acme/ws --body-file')
		expect(readFileSync(join(s.tmp, 'result.md'), 'utf8')).toContain('Research PR: https://github.com/acme/ws/pull/7')
		expect(readFileSync(join(s.tmp, 'pr-url'), 'utf8')).toBe('https://github.com/acme/ws/pull/7')
	})

	it('on failure opens no PR and comments the failure', () => {
		const s = setup('fail', 'Research did not produce output.\n')
		const result = publish(s)
		expect(result.status, result.stderr).toBe(0)
		const calls = readFileSync(s.log, 'utf8')
		expect(calls).not.toContain('pr create')
		expect(calls).toContain('issue comment 42')
		expect(git(s.remote, 'branch', '--list', 'be/research/issue-42')).toBe('')
	})

	it('when nothing wrote a result, comments a link to the run', () => {
		const s = setup('fail', '')
		publish(s)
		expect(readFileSync(join(s.tmp, 'result.md'), 'utf8')).toContain('actions/runs/99')
		expect(readFileSync(s.log, 'utf8')).toContain('issue comment 42')
	})

	it('cuts a result that is too long for one comment', () => {
		const s = setup('fail', 'x'.repeat(70000))
		publish(s)
		const text = readFileSync(join(s.tmp, 'result.md'), 'utf8')
		expect(text.length).toBeLessThan(61000)
		expect(text).toContain('The result was cut')
	})
})

describe('run-agent.sh', () => {
	/** Fake `npm` and `copilot` on PATH; `copilot` records its arguments and prints a result. */
	const agent = (env: Record<string, string>) => {
		const bin = join(root, 'bin')
		mkdirSync(bin)
		const log = join(root, 'copilot.log')
		writeFileSync(join(bin, 'npm'), '#!/usr/bin/env bash\nexit 0\n')
		writeFileSync(join(bin, 'copilot'), `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${log}"\necho "The answer."\n`)
		chmodSync(join(bin, 'npm'), 0o755)
		chmodSync(join(bin, 'copilot'), 0o755)
		const tmp = join(root, 'tmp')
		mkdirSync(tmp)
		const result = run('run-agent.sh', [], {
			cwd: root,
			env: {
				PATH: `${bin}:${process.env.PATH ?? ''}`,
				WS: 'be',
				INSTRUCTIONS: 'why?',
				ISSUE: '42',
				GITHUB_REPOSITORY: 'acme/ws',
				COPILOT_GITHUB_TOKEN: 'secret-token',
				RUNNER_TEMP: tmp,
				...env,
			},
		})
		return { result, args: existsSync(log) ? readFileSync(log, 'utf8').split('\n') : [], tmp }
	}

	it('passes --model when a model is set', () => {
		const { result, args, tmp } = agent({ MODEL: 'light-model' })
		expect(result.status, result.stderr).toBe(0)
		expect(args).toContain('--model')
		expect(args).toContain('light-model')
		expect(readFileSync(join(tmp, 'status'), 'utf8').trim()).toBe('ok')
	})

	it('passes no --model when the model is empty', () => {
		const { result, args } = agent({ MODEL: '' })
		expect(result.status, result.stderr).toBe(0)
		expect(args).not.toContain('--model')
	})

	it('fails with a clear message when the Copilot token is missing', () => {
		const { result, tmp } = agent({ COPILOT_GITHUB_TOKEN: '' })
		expect(result.status).toBe(1)
		expect(readFileSync(join(tmp, 'result.md'), 'utf8')).toContain('COPILOT_GITHUB_TOKEN')
	})
})

describe('resolve-command.sh', () => {
	const resolve = (command: string) => {
		const tmp = join(root, 'tmp')
		mkdirSync(tmp)
		const out = join(root, 'github-output')
		writeFileSync(out, '')
		const result = run('resolve-command.sh', [], { cwd: root, env: { COMMAND: command, RUNNER_TEMP: tmp, GITHUB_OUTPUT: out } })
		const read = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : '')
		return { code: result.status, output: read(out), status: read(join(tmp, 'status')).trim(), message: read(join(tmp, 'result.md')) }
	}

	it('maps research to the Research column', () => {
		expect(resolve('research')).toMatchObject({ code: 0, output: 'card-status=Research\n', status: '' })
	})

	it('says a known phase is not supported yet', () => {
		const result = resolve('design')
		expect(result.code).toBe(1)
		expect(result.status).toBe('fail')
		expect(result.message).toContain('not supported yet')
	})

	for (const command of ['', 'frobnicate']) {
		it(`rejects the unknown command ${JSON.stringify(command)}`, () => {
			const result = resolve(command)
			expect(result.code).toBe(1)
			expect(result.message).toContain('Unknown command')
			expect(result.output).toBe('')
		})
	}
})

describe('build-prompt.sh', () => {
	/** A fake `gh` that answers `issue view` with a fixed title and body, or fails. */
	const prompt = (env: Record<string, string>, issue: { title: string; body: string } | 'fail') => {
		const bin = join(root, 'bin')
		mkdirSync(bin)
		const answer = issue === 'fail' ? 'exit 1' : `printf 'Title: %s\\n\\n%s' '${issue.title}' '${issue.body}'`
		writeFileSync(join(bin, 'gh'), `#!/usr/bin/env bash\n${answer}\n`)
		chmodSync(join(bin, 'gh'), 0o755)
		const result = run('build-prompt.sh', [], {
			cwd: root,
			env: { PATH: `${bin}:${process.env.PATH ?? ''}`, WS: 'be', ISSUE: '15', GITHUB_REPOSITORY: 'acme/ws', ...env },
		})
		return result.stdout
	}
	const issue = { title: 'Order hangs', body: 'The order waits when water is slow.' }

	it('uses the issue alone when there are no instructions', () => {
		const text = prompt({ INSTRUCTIONS: '' }, issue)
		expect(text).toContain('## Issue #15')
		expect(text).toContain('Order hangs')
		expect(text).toContain('The order waits when water is slow.')
		expect(text).not.toContain('Additional instructions')
	})

	it('adds the instructions after the issue, never instead of it', () => {
		const text = prompt({ INSTRUCTIONS: 'Focus on timeouts.' }, issue)
		expect(text).toContain('Order hangs')
		expect(text).toContain('## Additional instructions\nFocus on timeouts.')
		expect(text.indexOf('Order hangs')).toBeLessThan(text.indexOf('Focus on timeouts.'))
	})

	it('treats whitespace-only instructions as none', () => {
		expect(prompt({ INSTRUCTIONS: '  \n ' }, issue)).not.toContain('Additional instructions')
	})

	it('still builds a prompt when the issue cannot be read', () => {
		const text = prompt({ INSTRUCTIONS: 'Focus on timeouts.' }, 'fail')
		expect(text).toContain('The issue could not be read.')
		expect(text).toContain('Focus on timeouts.')
	})

	it('names the workspace and the read-only rule', () => {
		const text = prompt({ INSTRUCTIONS: '' }, issue)
		expect(text).toContain("the 'be' workspace")
		expect(text).toContain('Do not modify any file.')
	})
})

describe('report.sh', () => {
	/** A temp folder with a fake `curl` that logs every call. A call that asks for a token gets one. */
	const setup = (status: 'ok' | 'fail', http = '204') => {
		const tmp = join(root, 'tmp')
		mkdirSync(tmp)
		writeFileSync(join(tmp, 'status'), `${status}\n`)
		const bin = join(root, 'bin')
		mkdirSync(bin)
		const log = join(root, 'curl.log')
		writeFileSync(
			join(bin, 'curl'),
			`#!/usr/bin/env bash
echo "CALL $*" >> "${log}"
for a in "$@"; do case "$a" in @*) cat "\${a#@}" >> "${log}"; echo >> "${log}";; esac; done
case "$*" in *audience=*) echo '{"value":"jwt-123"}';; *) printf '${http}';; esac
`,
		)
		chmodSync(join(bin, 'curl'), 0o755)
		return { tmp, bin, log }
	}

	const report = (s: ReturnType<typeof setup>, env: Record<string, string> = {}) =>
		run('report.sh', [], {
			cwd: root,
			env: {
				PATH: `${s.bin}:${process.env.PATH ?? ''}`,
				BROKER_ORIGIN: 'https://broker.example.net',
				DELIVERY_ID: 'd-1',
				WS: 'be',
				ISSUE: '42',
				RUNNER_TEMP: s.tmp,
				ACTIONS_ID_TOKEN_REQUEST_URL: 'https://token.example/req?x=1',
				ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'req-token',
				GITHUB_REPOSITORY: 'acme/ws',
				GITHUB_SERVER_URL: 'https://github.com',
				GITHUB_RUN_ID: '99',
				...env,
			},
		})

	it('on success posts complete with the links', () => {
		const s = setup('ok')
		writeFileSync(join(s.tmp, 'comment-url'), 'https://github.com/acme/ws/issues/42#issuecomment-1')
		writeFileSync(join(s.tmp, 'pr-url'), 'https://github.com/acme/ws/pull/7')
		const r = report(s)
		expect(r.status, r.stderr).toBe(0)
		const calls = readFileSync(s.log, 'utf8')
		expect(calls).toContain('audience=https://broker.example.net')
		expect(calls).toContain('https://broker.example.net/research-session/d-1/complete')
		expect(calls).toContain('Authorization: Bearer jwt-123')
		expect(calls).toContain('issuecomment-1')
		expect(calls).toContain('pull/7')
		expect(r.stdout).toContain('Reported')
	})

	it('on failure posts fail with the run link', () => {
		const s = setup('fail')
		const r = report(s)
		expect(r.status).toBe(0)
		const calls = readFileSync(s.log, 'utf8')
		expect(calls).toContain('/research-session/d-1/fail')
		expect(calls).toContain('actions/runs/99')
	})

	it('sends nothing without a delivery (a manual dispatch)', () => {
		const s = setup('ok')
		const r = report(s, { BROKER_ORIGIN: '', DELIVERY_ID: '' })
		expect(r.status).toBe(0)
		expect(existsSync(s.log)).toBe(false)
	})

	it('sends nothing to an origin that is not https', () => {
		const s = setup('ok')
		const r = report(s, { BROKER_ORIGIN: 'http://broker.example.net' })
		expect(r.status).toBe(0)
		expect(existsSync(s.log)).toBe(false)
		expect(r.stdout).toContain('not https')
	})

	it('warns, and does not fail the job, without an identity token', () => {
		const s = setup('ok')
		const r = report(s, { ACTIONS_ID_TOKEN_REQUEST_URL: '', ACTIONS_ID_TOKEN_REQUEST_TOKEN: '' })
		expect(r.status).toBe(0)
		expect(r.stdout).toContain('id-token: write')
		expect(existsSync(s.log)).toBe(false)
	})

	it('warns, and does not fail the job, when the broker refuses', () => {
		const s = setup('ok', '401')
		const r = report(s)
		expect(r.status).toBe(0)
		expect(r.stdout).toContain('HTTP 401')
	})
})
