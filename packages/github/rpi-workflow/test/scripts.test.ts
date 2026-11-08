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
	const setup = (status: 'ok' | 'fail', result: string, out?: string, options: { prFails?: boolean; summary?: string } = {}) => {
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
		if (options.summary !== undefined) writeFileSync(join(tmp, 'summary.md'), options.summary)

		const bin = join(root, 'bin')
		mkdirSync(bin)
		const log = join(root, 'gh.log')
		// The fake `gh` logs every call (all arguments, one line each call, newlines kept) and answers like GitHub does.
		const prCreate = options.prFails === true ? 'exit 1' : 'echo https://github.com/acme/ws/pull/7'
		const prView = options.prFails === true ? 'exit 1' : 'echo https://github.com/acme/ws/pull/7'
		writeFileSync(
			join(bin, 'gh'),
			`#!/usr/bin/env bash
echo "CALL $*" >> "${log}"
if [ "$1" = pr ] && [ "$2" = create ]; then ${prCreate}; fi
if [ "$1" = pr ] && [ "$2" = view ]; then ${prView}; fi
if [ "$1" = issue ] && [ "$2" = comment ]; then echo https://github.com/acme/ws/issues/42#issuecomment-1; fi
`,
		)
		chmodSync(join(bin, 'gh'), 0o755)
		return { dir, tmp, bin, log, remote }
	}

	const publish = (s: ReturnType<typeof setup>, env: Record<string, string> = {}) =>
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
				...env,
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

	describe('short comment', () => {
		const FULL = '# Why CI fails\n\nFULL-TEXT-MARKER the long evidence list.\n'
		const GOOD_MERMAID = '```mermaid\nflowchart LR\n  A --> B\n```'
		const SUMMARY = `The cache key is stale.\n\n- It is set in repo/ci.yml:12\n\n${GOOD_MERMAID}\n`
		const comment = (s: ReturnType<typeof setup>) => readFileSync(join(s.tmp, 'result.md'), 'utf8')
		const prCall = (s: ReturnType<typeof setup>) => readFileSync(s.log, 'utf8')

		it('uses the summary and the links in the comment, not the full text', () => {
			const s = setup('ok', FULL, FULL, { summary: SUMMARY })
			expect(publish(s).status).toBe(0)
			const text = comment(s)
			expect(text).toContain('The cache key is stale.')
			expect(text).toContain('```mermaid')
			expect(text).not.toContain('FULL-TEXT-MARKER')
			expect(text).toContain(
				'Research file: https://github.com/acme/ws/blob/be/research/issue-42/workspaces/be/research/issue-42.md',
			)
			expect(text).toContain('Research PR: https://github.com/acme/ws/pull/7')
		})

		it('puts the same summary in the PR description with the two fixed lines', () => {
			const s = setup('ok', FULL, FULL, { summary: SUMMARY })
			publish(s)
			const calls = prCall(s)
			expect(calls).toContain('Refs #42')
			expect(calls).toContain('The cache key is stale.')
			expect(calls).toContain('Merging this PR approves it.')
			expect(calls).not.toContain('FULL-TEXT-MARKER')
		})

		it('still commits the full research to the file in the PR', () => {
			const s = setup('ok', FULL, FULL, { summary: SUMMARY })
			publish(s)
			expect(git(s.remote, 'show', 'be/research/issue-42:workspaces/be/research/issue-42.md')).toContain('FULL-TEXT-MARKER')
		})

		it('saves the PR url and the comment url, and keeps the repeat marker', () => {
			const s = setup('ok', FULL, FULL, { summary: SUMMARY })
			publish(s, { RUN_ID: 'r-1' })
			expect(readFileSync(join(s.tmp, 'pr-url'), 'utf8')).toBe('https://github.com/acme/ws/pull/7')
			expect(readFileSync(join(s.tmp, 'comment-url'), 'utf8').trim()).toBe('https://github.com/acme/ws/issues/42#issuecomment-1')
			expect(comment(s)).toContain('<!-- slopfactory-run:r-1 -->')
		})

		it.each([
			['is missing', undefined],
			['is empty', ''],
			['is over 8000 characters', 'y'.repeat(8001)],
			['looks like it holds a token', 'The answer. ghp_abcdefghijklmnopqrstuvwxyz0123456789\n'],
		])('falls back to a short text when the summary %s', (_name, summary) => {
			const out = `# Why CI fails\n\n${Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n')}\nFULL-TEXT-MARKER\n`
			const s = setup('ok', out, out, summary === undefined ? {} : { summary })
			publish(s)
			const text = comment(s)
			expect(text).toContain('# Why CI fails')
			expect(text).toContain('line 3')
			expect(text).not.toContain('line 20')
			expect(text).not.toContain('FULL-TEXT-MARKER')
			expect(text).not.toContain('ghp_')
			expect(text).toContain('The short summary was not available')
			expect(text).toContain('Research PR: https://github.com/acme/ws/pull/7')
		})

		it('drops a broken mermaid block and keeps the text', () => {
			const broken = 'The answer.\n\n- A finding\n\n```mermaid\nflowchart LR\n  A --> B\n'
			const s = setup('ok', FULL, FULL, { summary: broken })
			publish(s)
			const text = comment(s)
			expect(text).toContain('The answer.')
			expect(text).toContain('- A finding')
			expect(text).not.toContain('mermaid')
			expect(text).toContain('Research PR:')
		})

		it('posts the full text, cut to fit, when no PR could be opened', () => {
			const s = setup('ok', FULL, FULL, { summary: SUMMARY, prFails: true })
			publish(s)
			const text = comment(s)
			expect(text).toContain('FULL-TEXT-MARKER')
			expect(text).toContain('The research pull request could not be opened')
			expect(text).not.toContain('Research file:')
			expect(existsSync(join(s.tmp, 'pr-url'))).toBe(false)
		})

		it('cuts the full text in the no-PR case when it is too long', () => {
			const big = `# T\n${'x'.repeat(70000)}\n`
			const s = setup('ok', big, big, { summary: SUMMARY, prFails: true })
			publish(s)
			expect(comment(s).length).toBeLessThan(61000)
			expect(comment(s)).toContain('The result was cut')
		})

		it('keeps the short failure comment when the agent failed', () => {
			const s = setup('fail', 'Research did not produce output.\n', undefined, { summary: SUMMARY })
			publish(s)
			expect(comment(s)).toContain('Research did not produce output.')
			expect(comment(s)).not.toContain('The cache key is stale.')
			expect(prCall(s)).not.toContain('pr create')
		})
	})
})

describe('clean-summary.sh', () => {
	const clean = (text: string) => {
		const file = join(root, 'in.md')
		writeFileSync(file, text)
		const result = run('clean-summary.sh', [file], { cwd: root })
		expect(result.status, result.stderr).toBe(0)
		return result.stdout
	}
	const fences = (text: string) => (text.match(/^```mermaid$/gm) ?? []).length
	const diagram = (body: string) => `\`\`\`mermaid\n${body}\n\`\`\`\n`

	it('keeps text and a valid diagram unchanged', () => {
		const input = `Answer.\n\n${diagram('flowchart LR\n  A --> B')}\nMore text.\n`
		expect(clean(input)).toBe(input)
	})

	it('keeps at most 2 mermaid fences', () => {
		const one = diagram('sequenceDiagram\n  A->>B: hi')
		const out = clean(`${one}\ntext\n\n${one}\n${one}\n${one}`)
		expect(fences(out)).toBe(2)
		expect(out).toContain('text')
	})

	it('drops a mermaid fence that is not closed', () => {
		const out = clean('Answer.\n\n```mermaid\nflowchart LR\n  A --> B\n')
		expect(fences(out)).toBe(0)
		expect(out).toContain('Answer.')
		expect(out).not.toContain('flowchart')
	})

	it('drops a mermaid fence with an unknown first word', () => {
		const out = clean(`Before.\n\n${diagram('this is not a diagram')}\nAfter.\n`)
		expect(fences(out)).toBe(0)
		expect(out).toContain('Before.')
		expect(out).toContain('After.')
	})

	it('drops an empty mermaid fence', () => {
		expect(fences(clean(diagram('')))).toBe(0)
	})

	it('does not count a broken fence against the limit of 2', () => {
		const good = diagram('flowchart TD\n  A --> B')
		const out = clean(`${diagram('nonsense')}\n${good}\n${good}`)
		expect(fences(out)).toBe(2)
	})

	it('closes another fence that is not closed', () => {
		const out = clean('Text.\n\n```diff\n-a\n+b\n')
		expect(out.trimEnd().endsWith('```')).toBe(true)
		expect(out).toContain('+b')
	})

	it('keeps closed code fences of other kinds as they are', () => {
		const input = 'A.\n\n```text\nsrc/\n└── a.ts\n```\n'
		expect(clean(input)).toBe(input)
	})
})

describe('summarize.sh', () => {
	/** A fake `copilot` that records its arguments and prints the given summary (or fails). */
	const summarize = (options: { status?: string; out?: string; copilot?: string; env?: Record<string, string> }) => {
		const bin = join(root, 'bin')
		mkdirSync(bin)
		const log = join(root, 'copilot.log')
		const promptFile = join(root, 'prompt.txt')
		const tmp = join(root, 'tmp')
		mkdirSync(tmp)
		writeFileSync(join(tmp, 'status'), `${options.status ?? 'ok'}\n`)
		if (options.out !== undefined) writeFileSync(join(tmp, 'out.md'), options.out)
		writeFileSync(
			join(bin, 'copilot'),
			options.copilot ??
				`#!/usr/bin/env bash\nwhile [ $# -gt 0 ]; do if [ "$1" = -p ]; then printf '%s' "$2" > "${promptFile}"; shift 2; continue; fi; printf '%s\\n' "$1" >> "${log}"; shift; done\necho "The summary."\n`,
		)
		chmodSync(join(bin, 'copilot'), 0o755)
		const result = run('summarize.sh', [], {
			cwd: root,
			env: {
				PATH: `${bin}:${process.env.PATH ?? ''}`,
				RUNNER_TEMP: tmp,
				COPILOT_GITHUB_TOKEN: 'secret-token',
				...options.env,
			},
		})
		const summary = join(tmp, 'summary.md')
		return {
			result,
			summary: existsSync(summary) ? readFileSync(summary, 'utf8') : undefined,
			args: existsSync(log) ? readFileSync(log, 'utf8').split('\n') : [],
			prompt: existsSync(promptFile) ? readFileSync(promptFile, 'utf8') : '',
			tmp,
		}
	}

	it('writes the summary and puts the show-me rules and the research in the prompt', () => {
		const { result, summary, prompt } = summarize({ out: '# Title\nRESEARCH-BODY\n' })
		expect(result.status, result.stderr).toBe(0)
		expect(summary).toBe('The summary.\n')
		expect(prompt).toContain('RESEARCH-BODY')
		expect(prompt).toContain('Mermaid')
		expect(prompt).toContain('at most 2 Mermaid diagrams')
		expect(prompt).toContain('Help the reader understand the topic visually')
		expect(prompt).not.toContain('open path/to')
	})

	it('asks for a summary with no tools', () => {
		const { args } = summarize({ out: 'x\n' })
		expect(args.some((a) => a.startsWith('--allow-tool'))).toBe(false)
	})

	it('passes --model when a model is set', () => {
		const { args } = summarize({ out: 'x\n', env: { MODEL: 'light-model' } })
		expect(args).toContain('--model')
		expect(args).toContain('light-model')
	})

	it('does nothing when the research failed', () => {
		const { result, summary, args } = summarize({ status: 'fail', out: 'x\n' })
		expect(result.status).toBe(0)
		expect(summary).toBeUndefined()
		expect(args).toEqual([])
	})

	it('makes no summary, and does not fail, when the agent fails', () => {
		const { result, summary } = summarize({ out: 'x\n', copilot: '#!/usr/bin/env bash\nexit 3\n' })
		expect(result.status).toBe(0)
		expect(summary).toBeUndefined()
	})

	it('makes no summary when the agent prints nothing', () => {
		const { result, summary } = summarize({ out: 'x\n', copilot: '#!/usr/bin/env bash\nexit 0\n' })
		expect(result.status).toBe(0)
		expect(summary).toBeUndefined()
	})

	it('withholds a summary that holds the token', () => {
		const { result, summary } = summarize({
			out: 'x\n',
			copilot: '#!/usr/bin/env bash\necho "leak secret-token here"\n',
		})
		expect(result.status).toBe(0)
		expect(summary).toBeUndefined()
		expect(result.stdout).toContain('withheld')
	})

	it('cuts a very long research file to fit one argument', () => {
		const { prompt } = summarize({ out: `# T\n${'z'.repeat(150000)}\n` })
		expect(prompt.length).toBeLessThan(125000)
		expect(prompt).toContain('The research was cut here')
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

	it('accepts research and names no board column (the broker owns the card states)', () => {
		expect(resolve('research')).toMatchObject({ code: 0, output: '', status: '' })
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
