#!/usr/bin/env node
/**
 * AuraCardea — Chat node kind drift check.
 *
 * The `conversation.chat.node` key table is merge-extensible: every Chat business
 * module adds entries to `ChatNodeDataMap`, so the set of node kinds changes
 * between DSH releases (0.2.1 added `question-reply` and `turn-trigger`). This
 * script re-derives the current set from the installed client bundles and diffs
 * it against the rules this plugin carries, so an upgrade is one command instead
 * of a surprise in the transcript.
 *
 *   node ~/.dsh/plugins/aura-cardea/tools/check-kinds.mjs [<dir> ...] [--json]
 *
 * Each <dir> may be a `node_modules`, a scope directory such as
 * `.../node_modules/@deepseek-ai`, or any directory holding package folders.
 * Without arguments it uses $DSH_NODE_MODULES, else the DSH install that sits
 * next to the CLI on this machine.
 *
 * Exit code 0 = every discovered kind has a rule; 1 = drift; 2 = nothing scanned.
 */

import { readFileSync, statSync } from 'node:fs'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

/** Plugin rules, kept in sync with lib/client.js. */
const INDEPENDENT = new Set([
	'system-prompt',
	'user',
	'steering',
	'turn-process',
	'turn-error',
	'turn-max-tokens',
	'turn-tail',
	'question-reply',
])
const PROCESS = new Set([
	'assistant-step',
	'command',
	'command-input',
	'compaction',
	'context',
	'manual-compaction',
	'model-retry',
	'tool-call',
	'turn-trigger',
	'workflow-run',
	'unknown',
])

/** Is this path a directory (following symlinks)? */
function isDir(path) {
	try {
		return statSync(path).isDirectory()
	} catch {
		return false
	}
}

/** Expand one root into package directories (handles a scope level). */
function packagesOf(root) {
	if (!isDir(root)) return []
	let entries
	try {
		entries = readdirSync(root)
	} catch {
		return []
	}
	const packages = []
	for (const name of entries) {
		if (name === '.bin' || name === '.pnpm' || name.startsWith('.')) continue
		const full = join(root, name)
		if (name.startsWith('@')) {
			for (const inner of readdirSync(full)) packages.push(join(full, inner))
			continue
		}
		packages.push(full)
	}
	return packages
}

/**
 * Chat node kinds one bundle mentions.
 *
 * Two sources: the keyed registrations a plugin adds itself
 * (`name: "conversation.chat.node", key: "<kind>"`), and the owner's key table
 * when the bundle carries its documentation (`already taken: a, b, c`).
 * @param text - bundle source.
 * @returns kinds named by the bundle.
 */
function kindsOfBundle(text) {
	const kinds = new Set()
	for (const match of text.matchAll(/name:\s*"conversation\.chat\.node",\s*key:\s*"([a-z0-9-]+)"/g)) kinds.add(match[1])
	const table = /already taken:\s*([a-z0-9-]+(?:,\s*[a-z0-9-]+)+)/.exec(text)
	if (table !== null) for (const kind of table[1].split(',')) kinds.add(kind.trim())
	return kinds
}

const args = process.argv.slice(2)
const json = args.includes('--json')
const roots = args.filter((arg) => !arg.startsWith('--'))
if (roots.length === 0) {
	if (typeof process.env.DSH_NODE_MODULES === 'string' && process.env.DSH_NODE_MODULES !== '') roots.push(process.env.DSH_NODE_MODULES)
	else {
		const home = process.env.USERPROFILE ?? process.env.HOME ?? ''
		if (home !== '') roots.push(join(home, '.dsh', 'profiles', 'web', 'node_modules'))
	}
}

const discovered = new Set()
let scanned = 0
for (const root of roots) {
	for (const pkg of packagesOf(root)) {
		const file = join(pkg, 'lib', 'client.js')
		let text
		try {
			text = readFileSync(file, 'utf8')
		} catch {
			continue
		}
		scanned += 1
		if (!text.includes('conversation.chat.node')) continue
		for (const kind of kindsOfBundle(text)) discovered.add(kind)
	}
}

const all = [...discovered].sort()
const unruled = all.filter((kind) => !INDEPENDENT.has(kind) && !PROCESS.has(kind))

if (json) console.log(JSON.stringify({ scanned, discovered: all, unruled }, null, 2))
else {
	console.log('scanned bundles: ' + scanned)
	console.log('chat node kinds (' + all.length + '): ' + (all.length === 0 ? '—' : all.join(', ')))
	if (all.length === 0) {
		console.log('\n✗ nothing discovered — point the command at a directory holding the DSH client packages')
	} else if (unruled.length === 0) {
		console.log('\n✓ every discovered kind has a rule')
	} else {
		console.log('\n⚠ kinds without a rule (they fold by raw name and warn once at runtime):')
		console.log('  ' + unruled.join(', '))
		console.log('\nupdate INDEPENDENT_KINDS / KNOWN_PROCESS_KINDS in lib/client.js, then this list.')
	}
}

process.exit(all.length === 0 ? 2 : unruled.length === 0 ? 0 : 1)
