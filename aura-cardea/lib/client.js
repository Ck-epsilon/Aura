/**
 * `aura-cardea` — browser half.
 *
 * Replaces the Chat `turn-process` node renderer with a per-kind fold of one
 * turn's intermediate rows: the summary line reports the running tool and the
 * turn totals, and every category row (one per tool name, plus 思考 / 上下文注入 /
 * 重试 …) expands its own items inline.
 *
 * Everything the renderer needs comes from standard/owner slot props:
 * `useChat` for the ordered node set, `turnProcess` for the shipped fold state,
 * `loadImage` for durable image thumbnails. Folded rows are hidden by a
 * document-scoped stylesheet keyed on each row's stable `data-chat-anchor-key`,
 * so no shipped renderer is reimplemented and nothing is unmounted.
 *
 * The bundle is hand-written in the same factory format the shipped client
 * packages use; `react` resolves from the shell's platform module table.
 */
window.__ModuleLoader__.load({
	id: 'aura-cardea',
	factory: (require) => {
		const React = require('react')
		var module = { exports: {} }
		var exports = module.exports

/**
 * Build stamp of this bundle.
 *
 * The browser bundle is a snapshot taken at page load, so a `dsh web` restart
 * alone never reaches an already-open tab. Stamping the row and logging once on
 * registration turns "did my change load?" into a single console line instead of
 * a guess: bump this whenever the bundle changes.
 */
const BUILD = '2026-10-21T23:35'

const BODY_LIMIT = 4000
const ITEM_LIMIT = 25
const ARG_KEYS = ['command', 'path', 'file_path', 'filePath', 'pattern', 'query', 'url', 'description', 'prompt', 'name', 'text']

const CSS = [
	'.dcg-chevron{flex:none;width:16px;height:16px;margin-left:6px;color:var(--dsw-alias-label-tertiary);transition:transform .1s;transform:rotate(0)}',
	'.dcg-proc[data-open] .dcg-chevron,.dcg-cat[data-open] .dcg-chevron{transform:rotate(90deg)}',
	'@media (prefers-reduced-motion:reduce){.dcg-chevron{transition:none}}',
	'.dcg-proc{box-sizing:border-box;display:flex;align-items:center;width:100%;min-width:0;height:30px;margin:0;padding:0 0 6px;border:0;background:none;color:var(--dsw-alias-label-secondary);font-family:inherit;text-align:left;cursor:pointer}',
	'.dcg-proc-dot{flex:none;width:7px;height:7px;margin-right:10px;border-radius:50%;background:var(--dsw-alias-brand-primary,rgba(90,140,255,.9))}',
	'.dcg-proc[data-turn-status="running"] .dcg-proc-dot{animation:dcg-dot-pulse 1.1s ease-in-out infinite}',
	'.dcg-proc[data-turn-status="idle"] .dcg-proc-dot{animation:dcg-dot-pulse 2s ease-in-out infinite}',
	'.dcg-proc[data-turn-status="done"] .dcg-proc-dot{background:var(--dsw-alias-label-caption,rgba(127,127,127,.55))}',
	'.dcg-proc-label{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:var(--dsh-content-font-size,14px);line-height:calc(22px + var(--dsh-content-font-delta,0px))}',
	'.dcg-proc:hover .dcg-proc-label{color:var(--dsw-alias-label-primary)}',
	'.dcg-stats{flex:none;display:flex;align-items:center;margin-left:8px;font-size:var(--dsh-content-font-size-secondary,13px);font-variant-numeric:tabular-nums}',
	'.dcg-ok{color:var(--dsw-alias-state-success-primary)}',
	'.dcg-fail{color:var(--dsw-alias-state-error-primary)}',
	'.dcg-cats{display:flex;flex-direction:column;margin:0 0 8px;padding:0 0 2px 17px;border-bottom:.5px solid var(--dsw-alias-border-l2)}',
	'.dcg-cat{box-sizing:border-box;display:flex;align-items:center;gap:6px;width:100%;min-width:0;height:24px;margin:0;padding:0 6px;border:0;background:none;font-family:inherit;font-size:var(--dsh-content-font-size-secondary,13px);line-height:24px;color:var(--dsw-alias-label-secondary);text-align:left;cursor:pointer;overflow:hidden}',
	'.dcg-cat:hover .dcg-cat-label{color:var(--dsw-alias-label-primary)}',
	'.dcg-cat .dcg-chevron{width:14px;height:14px;margin-left:0;margin-right:6px}',
	// A running row is tinted, not just marked: in a long fold the reader scans for
	// movement rather than for the word 正在运行. The tint deepens with age, and a
	// left accent bar makes the row findable even where the tint is subtle.
	'.dcg-cat[data-running]{background:rgba(90,140,255,.10);background:color-mix(in srgb, var(--dsw-alias-brand-primary, #5a8cff) 10%, transparent);box-shadow:inset 2px 0 0 rgba(90,140,255,.55);border-radius:5px}',
	'.dcg-cat[data-running][data-age="mid"]{background:rgba(90,140,255,.18);background:color-mix(in srgb, var(--dsw-alias-brand-primary, #5a8cff) 18%, transparent);box-shadow:inset 2px 0 0 rgba(90,140,255,.8)}',
	// Attention, not a semantic state: the long bucket stays in the brand hue and
	// escalates by weight only. A warning/error colour here would read as "something
	// failed", which a slow command has not done.
	'.dcg-cat[data-running][data-age="long"]{background:rgba(90,140,255,.26);background:color-mix(in srgb, var(--dsw-alias-brand-primary, #5a8cff) 26%, transparent);box-shadow:inset 2px 0 0 rgba(90,140,255,1)}',
	'.dcg-cat[data-running][data-age="long"] .dcg-cat-live{opacity:1}',
	'.dcg-cat-label{flex:0 1 auto;min-width:0;max-width:38%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
	'.dcg-cat-count{flex:none;color:var(--dsw-alias-label-caption,rgba(127,127,127,.55));font-variant-numeric:tabular-nums}',
	'.dcg-cat-error{flex:0 1 auto;min-width:0;max-width:26%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-state-error-primary);font-size:var(--dsh-content-font-size-secondary,13px);opacity:.85}',
	'.dcg-cat-duration{flex:none;color:var(--dsw-alias-label-caption,rgba(127,127,127,.55));font-variant-numeric:tabular-nums;font-size:var(--dsh-content-font-size-secondary,13px)}',
	'.dcg-cat-live{flex:none;display:inline-flex;align-items:center;color:var(--dsw-alias-brand-primary,rgba(90,140,255,.9))}',
	'.dcg-items{display:flex;flex-direction:column;margin:0 0 6px 20px}',
	'.dcg-item{box-sizing:border-box;display:flex;align-items:center;gap:6px;width:100%;min-width:0;margin:0;padding:0 6px;border:0;background:none;font-family:inherit;font-size:var(--dsh-content-font-size-secondary,13px);line-height:22px;color:var(--dsw-alias-label-tertiary);text-align:left;cursor:pointer;overflow:hidden}',
	'.dcg-item[data-static]{cursor:default}',
	'.dcg-item[data-running]{background:rgba(90,140,255,.12);background:color-mix(in srgb, var(--dsw-alias-brand-primary, #5a8cff) 12%, transparent);box-shadow:inset 2px 0 0 rgba(90,140,255,.6);border-radius:5px}',
	'.dcg-item[data-running][data-age="mid"]{background:rgba(90,140,255,.20);background:color-mix(in srgb, var(--dsw-alias-brand-primary, #5a8cff) 20%, transparent);box-shadow:inset 2px 0 0 rgba(90,140,255,.9)}',
	'.dcg-item[data-running][data-age="long"]{background:rgba(90,140,255,.24);background:color-mix(in srgb, var(--dsw-alias-brand-primary, #5a8cff) 24%, transparent);box-shadow:inset 2px 0 0 rgba(90,140,255,.95)}',
	'.dcg-item:hover .dcg-item-name{color:var(--dsw-alias-label-primary)}',
	'.dcg-item-mark{flex:none;width:14px;text-align:center;font-size:11px;color:var(--dsw-alias-label-caption)}',
	// Three keys pressed in sequence: a piano hand moving left to right, at 10px tall
	// and low opacity so it reads as activity rather than decoration.
	'.dcg-keys{display:inline-flex;align-items:flex-end;gap:2px;height:11px;margin:0 6px 0 2px;color:var(--dsw-alias-brand-primary,rgba(90,140,255,.9))}',
	'.dcg-keys i{display:block;width:3px;border-radius:1px;background:currentColor;opacity:.35;transform-origin:bottom;animation:dcg-key 2.2s ease-in-out infinite}',
	'.dcg-keys i:nth-child(1){height:6px;animation-delay:0s}',
	'.dcg-keys i:nth-child(2){height:10px;animation-delay:.22s}',
	'.dcg-keys i:nth-child(3){height:7px;animation-delay:.44s}',
	// One key up at a time, with a long rest between presses: legible as separate
	// taps rather than a shimmer.
	'@keyframes dcg-key{0%,66%,100%{transform:scaleY(.3);opacity:.3}22%{transform:scaleY(1);opacity:1}}',
	'@keyframes dcg-key-fade{0%,66%,100%{opacity:.3}22%{opacity:1}}',
	// Reduced motion keeps the heartbeat but drops the movement: opacity only.
	'@media (prefers-reduced-motion:reduce){.dcg-keys i{animation:dcg-key-fade 2.2s ease-in-out infinite;transform:none}}',
	'.dcg-item-mark[data-state="ok"]{color:var(--dsw-alias-state-success-primary)}',
	'.dcg-item-mark[data-state="error"]{color:var(--dsw-alias-state-error-primary)}',
	// The mark no longer pulses: the key cluster inside it carries the motion, and a
	// wrapper pulse on top of it made the whole group blink.
	'.dcg-item-mark[data-state="running"]{color:var(--dsw-alias-brand-primary,rgba(90,140,255,.9))}',
	'.dcg-item-name{flex:0 1 auto;min-width:0;max-width:min(170px,32%);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary)}',
	'.dcg-item-text{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
	'.dcg-item-ord{flex:none;color:var(--dsw-alias-label-caption);font-size:11px;font-variant-numeric:tabular-nums}',
	'.dcg-item-clock{flex:none;color:var(--dsw-alias-label-caption);font-variant-numeric:tabular-nums;font-size:11px}',
	'.dcg-item-time{flex:none;color:var(--dsw-alias-label-caption);font-variant-numeric:tabular-nums}',
	'.dcg-item-chevron{flex:none;color:var(--dsw-alias-label-caption);font-size:10px}',
	'.dcg-item-exit{flex:none;padding:0 5px;border-radius:4px;background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 16%, transparent);color:var(--dsw-alias-state-error-primary);font-size:11px;line-height:16px;font-variant-numeric:tabular-nums}',
	'.dcg-thumbs{display:flex;flex-wrap:wrap;gap:6px;margin:2px 0 6px 20px}',
	'.dcg-thumb{display:block;max-width:220px;max-height:150px;border:.5px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-2);object-fit:contain;cursor:zoom-in}',
	'.dcg-thumb-pending{display:inline-flex;align-items:center;height:28px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l2);border-radius:6px;color:var(--dsw-alias-label-caption);font-size:var(--dsh-content-font-size-secondary,13px)}',
	'.dcg-zoom{position:fixed;inset:0;z-index:1200;display:flex;align-items:center;justify-content:center;padding:40px;background:rgba(0,0,0,.78);cursor:zoom-out}',
	'.dcg-zoom-img{display:block;max-width:100%;max-height:100%;border-radius:8px;background:#fff;object-fit:contain;box-shadow:0 16px 56px rgba(0,0,0,.55);cursor:zoom-out}',
	'.dcg-zoom-close{position:absolute;top:18px;right:22px;width:34px;height:34px;padding:0;border:0;border-radius:50%;background:rgba(255,255,255,.16);color:#fff;font-size:18px;line-height:34px;text-align:center;cursor:pointer}',
	'.dcg-zoom-close:hover{background:rgba(255,255,255,.28)}',
	'.dcg-zoom-hint{position:absolute;bottom:18px;left:0;right:0;text-align:center;color:rgba(255,255,255,.65);font-size:12px}',
	'.dcg-more{align-self:flex-start;margin:2px 0 4px;padding:0;border:0;background:none;color:var(--dsw-alias-label-tertiary);font-family:inherit;font-size:var(--dsh-content-font-size-secondary,13px);line-height:22px;cursor:pointer}',
	'.dcg-more:hover{color:var(--dsw-alias-label-primary);text-decoration:underline}',
	'.dcg-body{box-sizing:border-box;width:calc(100% - 22px - var(--dsh-content-font-delta,0px));max-height:180px;margin:4px 0 8px calc(22px + var(--dsh-content-font-delta,0px));padding:10px 16px 12px 12px;border:0;border-radius:8px;background:var(--dsw-alias-markdown-code-block,rgba(127,127,127,.08));color:var(--dsw-alias-label-tertiary);font:400 11px/16px var(--ds-font-family-code,ui-monospace,monospace);white-space:pre-wrap;word-break:break-word;overflow:auto}',
	'@keyframes dcg-dot-pulse{0%,100%{opacity:.25}50%{opacity:1}}',
	'@media (prefers-reduced-motion:reduce){.dcg-proc-dot,.dcg-cat-live,.dcg-item-mark{animation:none}}',
	'[data-chat-flow-kind="turn-process"][data-turn-process-hidden]{display:block!important;content-visibility:visible!important}',
].join('\n')

/**
 * Kinds that never fold.
 *
 * This is the fail-visible half of the design: a kind listed here (or one this
 * build has never seen) keeps its own row, so a newer Chat that introduces a
 * content-bearing kind cannot be hidden behind a fold. Foldable kinds are the
 * process ones handled below; everything else falls into `kind:<name>`.
 */
const INDEPENDENT_KINDS = {
	'system-prompt': true,
	user: true,
	steering: true,
	'turn-process': true,
	'turn-error': true,
	'turn-max-tokens': true,
	'turn-tail': true,
	// 0.2.1: an answer to the agent's own question tool — content, never process.
	'question-reply': true,
}

/** Kinds this build knows how to categorize; anything else is reported once. */
const KNOWN_PROCESS_KINDS = {
	'assistant-step': true,
	'command': true,
	'command-input': true,
	'compaction': true,
	'context': true,
	'manual-compaction': true,
	'model-retry': true,
	'tool-call': true,
	'turn-trigger': true,
	'workflow-run': true,
	'unknown': true,
}

/**
 * Report a Chat Node kind this build has no rule for.
 *
 * The list of kinds is merge-extensible and grows between releases (0.2.1 added
 * `question-reply` and `turn-trigger`). Unknown kinds still fold by their raw
 * name — the warning is what makes the next upgrade visible in the console
 * instead of silently mis-grouped.
 */
const reportedKinds = new Set()
function warnUnknownKind(kind) {
	if (reportedKinds.has(kind)) return
	reportedKinds.add(kind)
	console.warn('aura-cardea: no rule for Chat node kind "' + kind + '" — folding it as kind:' + kind + '; update KNOWN_PROCESS_KINDS / INDEPENDENT_KINDS')
}

const FALLBACK = {
	think: '思考',
	context: '上下文注入',
	retry: '重试',
	command: '命令',
	compaction: '上下文压缩',
	trigger: '触发',
	workflow: '工作流',
	tool: '工具',
	running: '正在运行',
	thinking: '思考中',
	liveSuffix: '正在运行',
	toolCalls: '{count} 次工具调用',
	messages: '{count} 条消息',
	subagents: '{count} 个 subagent',
	thought: '已思考',
	separator: ' · ',
}

/**
 * Translate through the Chat locale seat, falling back to bundled copy.
 * @param t - Chat locale seat, possibly absent.
 * @param key - Chat namespace key.
 * @param params - interpolation parameters, when the key takes any.
 * @param fallback - copy used when the seat is absent or the key is unknown.
 * @returns localized or fallback copy.
 */
function tr(t, key, params, fallback) {
	if (typeof t === 'function') {
		try {
			const value = params === undefined ? t(key) : t(key, params)
			if (typeof value === 'string' && value !== '' && value !== key) return value
		} catch (error) {
			console.error('aura-cardea: locale lookup failed for ' + key, error)
		}
	}
	if (typeof fallback !== 'string') return key
	return fallback.replace('{count}', params === undefined || params === null ? '' : String(params.count))
}

/** Read one node's payload, or null. */
function dataOf(node) {
	if (node === undefined || node === null) return null
	const data = node.data
	return data === undefined || data === null ? null : data
}

/** Producer label of an injected context node, or null. */
function labelOf(node) {
	const data = dataOf(node)
	const provenance = data === null ? null : data.provenance
	if (provenance === undefined || provenance === null) return null
	const label = provenance.label
	return typeof label === 'string' && label !== '' ? label : null
}

/** Assistant or content block list of a node, or null. */
function blocksOf(node) {
	const data = dataOf(node)
	const blocks = data === null ? null : data.blocks !== undefined && data.blocks !== null ? data.blocks : data.content
	return Array.isArray(blocks) ? blocks : null
}

/**
 * Join the text of the wanted block kinds.
 * @param blocks - source blocks, or null.
 * @param wanted - 'text', 'reasoning', or 'any' (both).
 * @returns joined text, possibly empty.
 */
function textFromBlocks(blocks, wanted) {
	if (blocks === null) return ''
	const parts = []
	for (const block of blocks) {
		if (block === null || typeof block !== 'object') continue
		const kind = block.kind !== undefined ? block.kind : block.type
		if (wanted === 'text' && kind === 'text' && typeof block.text === 'string') parts.push(block.text)
		else if (wanted === 'reasoning' && kind === 'reasoning' && typeof block.text === 'string') parts.push(block.text)
		else if (wanted === 'any' && typeof block.text === 'string' && (kind === 'text' || kind === 'reasoning')) parts.push(block.text)
	}
	return parts.join('\n\n')
}

/** Durable image references carried by a result's content blocks. */
function imagesFromBlocks(blocks) {
	const images = []
	if (blocks === null) return images
	for (const block of blocks) {
		if (block === null || typeof block !== 'object') continue
		const kind = block.kind !== undefined ? block.kind : block.type
		if (kind !== 'image') continue
		const attachment = block.attachment
		if (attachment === undefined || attachment === null || typeof attachment !== 'object') continue
		if (typeof attachment.attachmentId !== 'string' || attachment.attachmentId === '') continue
		images.push({ attachment, name: typeof attachment.name === 'string' ? attachment.name : '' })
	}
	return images
}

/** Bound one text for inline rendering. */
function clip(text, limit) {
	if (typeof text !== 'string') return ''
	const max = typeof limit === 'number' ? limit : BODY_LIMIT
	if (text.length <= max) return text
	return text.slice(0, max) + '\n\n[已截断 ' + (text.length - max) + ' 字符]'
}

/** Whether an assistant node carries reply content that must stay visible. */
function hasAnswerBody(node) {
	const blocks = blocksOf(node)
	if (blocks === null) return false
	for (const block of blocks) {
		if (block === null || typeof block !== 'object') continue
		const kind = block.kind !== undefined ? block.kind : block.type
		if (kind === 'text' && typeof block.text === 'string' && block.text.trim() !== '') return true
		if (kind === 'image' || kind === 'other') return true
	}
	return false
}

/** Reasoning text of one assistant node. */
function reasoningTextOf(node) {
	const blocks = blocksOf(node)
	if (blocks === null) return ''
	return textFromBlocks(blocks, 'reasoning').trim()
}

/** Owning Turn number of a node, when its location carries one. */
function turnOfNode(node) {
	if (node === undefined || node === null) return undefined
	const location = node.location
	if (location === undefined || location === null) return undefined
	if (location.kind !== 'turn' && location.kind !== 'step') return undefined
	const turn = location.turn
	if (turn === undefined || turn === null) return undefined
	return typeof turn.turn === 'number' ? turn.turn : undefined
}

/** Whether a node's Turn has closed; undefined when the location cannot say. */
function turnClosedOf(node) {
	if (node === undefined || node === null) return undefined
	const location = node.location
	if (location === undefined || location === null || typeof location !== 'object') return undefined
	if (location.kind !== 'turn' && location.kind !== 'step') return undefined
	const turn = location.turn
	if (turn === undefined || turn === null || typeof turn !== 'object') return undefined
	const status = turn.status
	if (typeof status !== 'string') return undefined
	return status === 'closed'
}

/** Wire tool name of a tool row. */
function toolNameOf(node) {
	const data = dataOf(node)
	const root = data === null ? null : data.root
	if (root === undefined || root === null) return FALLBACK.tool
	if (root.kind === 'tool-result') {
		const call = root.call
		if (call !== undefined && call !== null && typeof call.name === 'string' && call.name !== '') return call.name
		return FALLBACK.tool
	}
	if (typeof root.name === 'string' && root.name !== '') return root.name
	return FALLBACK.tool
}

/** Whether a tool root has not settled. */
function toolRunning(root) {
	if (root === undefined || root === null) return false
	return root.kind !== 'tool-result'
}

/** Parse an argument JSON string into a plain object, or null. */
function parseArgs(raw) {
	if (typeof raw !== 'string' || raw.trim() === '') return null
	try {
		const parsed = JSON.parse(raw)
		if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
		return null
	} catch (error) {
		return null
	}
}

/** One-line argument summary: the salient fields, else the raw text. */
function argsSummary(root) {
	if (root === undefined || root === null) return ''
	let raw = ''
	if (root.kind === 'tool-result') {
		const call = root.call
		if (call !== undefined && call !== null && typeof call.argsRaw === 'string') raw = call.argsRaw
	} else if (typeof root.argsRaw === 'string') raw = root.argsRaw
	if (raw === '') return ''
	const parsed = parseArgs(raw)
	if (parsed !== null) {
		const parts = []
		for (const key of ARG_KEYS) {
			const value = parsed[key]
			if (typeof value === 'string' && value.trim() !== '') {
				parts.push(value.trim().replace(/\s+/g, ' ').slice(0, 70))
				if (parts.length >= 2) break
			}
		}
		if (parts.length > 0) return parts.join(' · ')
	}
	return raw.replace(/\s+/g, ' ').trim().slice(0, 160)
}

/** Display duration of one settled call. */
function durationOf(root) {
	if (root === undefined || root === null) return ''
	if (root.kind === 'tool-result') {
		if (typeof root.callTime !== 'number' || typeof root.time !== 'number') return ''
		return formatDuration(root.time - root.callTime)
	}
	return ''
}

/** Duration of one settled call in milliseconds. */
function durationMsOf(root) {
	if (root === undefined || root === null || root.kind !== 'tool-result') return 0
	if (typeof root.callTime !== 'number' || typeof root.time !== 'number') return 0
	const delta = root.time - root.callTime
	return isFinite(delta) && delta > 0 ? delta : 0
}

/** Local wall-clock time of one record, or undefined. */
function startedAtOf(node) {
	const data = dataOf(node)
	if (data === null) return undefined
	if (typeof data.time === 'number') return data.time
	if (typeof data.callTime === 'number') return data.callTime
	return undefined
}

/**
 * How long a call has been running, bucketed for the highlight ramp.
 *
 * Two minutes is where a call stops looking like a quick step; ten minutes is
 * where it becomes something the reader should notice without reading the label.
 * @param since - epoch milliseconds of the call start, or undefined.
 * @returns `short` | `mid` | `long`.
 */
/**
 * One-line failure summary for a category.
 *
 * `exit 1` when every failure shares one reason; `exit 1×6, +2 种` when reasons mix,
 * so a stray `exit 2` inside eight `exit 1`s cannot be silently dropped.
 * @param reasons - map of reason label to count.
 * @returns summary text, empty when nothing failed.
 */
function summarizeReasons(reasons) {
	if (reasons === undefined || reasons.size === 0) return ''
	const entries = [...reasons.entries()].sort((left, right) => right[1] - left[1] || (left[0] < right[0] ? -1 : 1))
	if (entries.length === 1) return entries[0][0]
	const [topLabel, topCount] = entries[0]
	return topLabel + '×' + topCount + ', +' + (entries.length - 1) + ' 种'
}

/** Full failure breakdown for a hover title; empty when nothing failed. */
function reasonTitle(reasons) {
	if (reasons === undefined || reasons.size === 0) return undefined
	const entries = [...reasons.entries()].sort((left, right) => right[1] - left[1] || (left[0] < right[0] ? -1 : 1))
	return entries.map(([label, count]) => label + '×' + count).join('\n')
}

function runningAge(since) {
	if (typeof since !== 'number' || !isFinite(since)) return 'short'
	const minutes = (Date.now() - since) / 60000
	if (minutes >= 10) return 'long'
	if (minutes >= 2) return 'mid'
	return 'short'
}

/** Clock label `22:40:12` for one epoch millisecond value, else empty. */
function formatClock(ms) {
	if (typeof ms !== 'number' || !isFinite(ms)) return ''
	const date = new Date(ms)
	const pad = (value) => String(value).padStart(2, '0')
	return pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds())
}

/** Compact duration: 97ms / 8.4s / 1m5s. */
function formatDuration(ms) {
	if (typeof ms !== 'number' || !isFinite(ms) || ms <= 0) return ''
	if (ms < 1000) return Math.round(ms) + 'ms'
	if (ms < 60000) return (ms / 1000).toFixed(1) + 's'
	if (ms < 3600000) {
		const minutes = Math.floor(ms / 60000)
		const seconds = Math.round((ms % 60000) / 1000)
		return minutes + 'm' + (seconds === 0 ? '' : seconds + 's')
	}
	// A stuck call can outlive an hour, and `5234m` is unreadable.
	if (ms < 86400000) {
		const hours = Math.floor(ms / 3600000)
		const minutes = Math.floor((ms % 3600000) / 60000)
		return hours + 'h' + (minutes === 0 ? '' : minutes + 'm')
	}
	const days = Math.floor(ms / 86400000)
	const hours = Math.floor((ms % 86400000) / 3600000)
	return days + 'd' + (hours === 0 ? '' : hours + 'h')
}

/**
 * Exit status a shell result reports in its own text.
 *
 * The shell executors settle a failing command as a completed call, so the status
 * exists only as the trailing `[exit code: N]` / `[killed by signal: X]` marker
 * the renderer owns — the same literals the shipping shell card parses.
 * @param name - wire tool name.
 * @param root - settled Tool result, or null.
 * @returns `{ code }`, `{ signal }`, or null when the result carries neither.
 */
function exitStatusOf(name, root) {
	if (name !== 'bash' && name !== 'pwsh' && name !== 'terminal_send') return null
	if (root === undefined || root === null || root.kind !== 'tool-result') return null
	const text = textFromBlocks(Array.isArray(root.content) ? root.content : null, 'any')
	if (text === '') return null
	const signal = /\n\[killed by signal: ([^\]\n]+)\]$/.exec(text)
	if (signal !== null && typeof signal[1] === 'string') return { signal: signal[1] }
	const exit = /\n\[exit code: (\d+)\]$/.exec(text)
	if (exit !== null) return { code: Number(exit[1]) }
	return null
}

/** Row copy of one exit status: `exit 2` / `signal SIGKILL`, else empty. */
function exitLabelOf(exit) {
	if (exit === null || exit === undefined) return ''
	if (exit.signal !== undefined) return 'signal ' + exit.signal
	if (typeof exit.code === 'number') return 'exit ' + exit.code
	return ''
}

/** Short failure text of one failed result. */
function errorShortOf(root) {
	if (root === undefined || root === null || root.kind !== 'tool-result') return ''
	if (root.isError !== true) return ''
	const error = root.error
	if (error !== undefined && error !== null && typeof error.name === 'string' && error.name !== '') return error.name
	const text = textFromBlocks(Array.isArray(root.content) ? root.content : null, 'any').trim()
	if (text === '') return ''
	return text.split('\n')[0].trim().slice(0, 60)
}

/** Expandable body of one tool item: its arguments then its output. */
function toolBodyOf(root) {
	if (root === undefined || root === null) return ''
	const parts = []
	if (root.kind === 'tool-result') {
		const call = root.call
		if (call !== undefined && call !== null && typeof call.argsRaw === 'string' && call.argsRaw !== '') parts.push(call.argsRaw)
		if (Array.isArray(root.content)) {
			const text = textFromBlocks(root.content, 'any').trim()
			if (text !== '') parts.push(text)
		}
		if (root.isError === true && root.error !== undefined && root.error !== null && typeof root.error.name === 'string') parts.push('[error] ' + root.error.name)
	} else if (typeof root.argsRaw === 'string' && root.argsRaw !== '') {
		parts.push(root.argsRaw)
	}
	return clip(parts.join('\n\n'))
}

/** Disclosure chevron; rotates through the parent's data-open attribute. */
/**
 * Activity indicator for one running row: three keys pressed in sequence.
 *
 * Cheaper and quieter than a pulsing dot repeated on every row, and it reads as
 * a hand moving across keys — one key lit at a time, never all at once.
 * @returns the inline key cluster.
 */
function RunningKeys() {
	return React.createElement('span', { className: 'dcg-keys', 'aria-hidden': 'true' },
		React.createElement('i', null),
		React.createElement('i', null),
		React.createElement('i', null),
	)
}

function chevron(open) {
	return React.createElement('svg', {
		className: 'dcg-chevron',
		viewBox: '0 0 16 16',
		width: 16,
		height: 16,
		'aria-hidden': 'true',
		focusable: 'false',
	}, React.createElement('path', {
		d: 'M6 3.5 10.5 8 6 12.5',
		fill: 'none',
		stroke: 'currentColor',
		strokeWidth: 1.3,
		strokeLinecap: 'round',
		strokeLinejoin: 'round',
	}))
}

/**
 * Bucket one Turn's process rows by kind.
 *
 * Categories aggregate tool calls by wire name and group reasoning, context
 * injections, retries and the remaining process kinds. Reply content is never
 * collected, and neither is any other row of another Turn: what stays visible
 * is decided only by kind and by whether a row carries reply content, not by
 * where the shipping Chat puts its answer boundary.
 *
 * @param spec - the Turn's process spec (data of the turn-process node).
 * @param order - visible Chat Node keys in presentation order.
 * @param store - live Chat Node store.
 * @param t - Chat locale seat.
 * @returns categories, their hidden row keys, inline-reasoning node keys, and totals.
 */
function collectProcess(spec, order, store, t) {
	const categories = []
	const index = {}
	// Position of each collected item in the Turn's own process order. Categories
	// regroup the rows by kind, so this is what lets a reader see interleaving
	// (`#12` in one category sits between `#11` and `#13` in another).
	let ordinal = 0
	const totals = { calls: 0, ok: 0, failed: 0, running: 0, runningNames: [] }
	const inlineThinkKeys = []
	const partHidden = []
	if (spec === null || spec === undefined) return { categories, totals, inlineThinkKeys, hidden: partHidden }
	if (order === undefined || order === null || typeof order.length !== 'number') return { categories, totals, inlineThinkKeys, hidden: partHidden }
	if (store === undefined || store === null || typeof store.get !== 'function') return { categories, totals, inlineThinkKeys, hidden: partHidden }
	const ensure = (key, label, think) => {
		let category = index[key]
		if (category === undefined) {
		category = { key, label, think, count: 0, ok: 0, failed: 0, running: 0, durationMs: 0, errorShort: '', reasons: new Map(), firstAt: undefined, lastAt: undefined, runningSince: undefined, nodes: [], items: [] }
			index[key] = category
			categories.push(category)
		}
		return category
	}

	for (const key of order) {
		const node = store.get(key)
		if (node === undefined || node === null) continue
		if (INDEPENDENT_KINDS[node.kind] === true) continue
		const turn = turnOfNode(node)
		if (turn !== undefined && turn !== spec.turn) continue
		const anchor = node.anchorSeq
		if (typeof anchor !== 'number') continue

		const answer = hasAnswerBody(node)
		const reasoning = node.kind === 'assistant-step' ? reasoningTextOf(node) : ''
		if (reasoning !== '') {
			const think = ensure('think', tr(t, 'message.think', undefined, FALLBACK.think), true)
			think.count += 1
			ordinal += 1
			think.items.push({ type: 'text', ordinal, key: key + ':think', name: think.label, preview: reasoning.replace(/\s+/g, ' ').slice(0, 200), body: clip(reasoning), images: [], startedAt: startedAtOf(node) })
			// The Chat flow renders one Node as one row per `groupPart`, and only the
			// plain (or `response`) part keeps the Node key: a reasoning part is keyed
			// `JSON.stringify([key, "reasoning"])`. Hide that row by its real key.
			partHidden.push(partKeyOf(key, 'reasoning'))
			if (answer) inlineThinkKeys.push(key)
			else think.nodes.push(key)
		}
		if (node.kind === 'assistant-step') {
			// A shell assistant row (no reply content, no reasoning) carries only the
			// shipped per-step process chrome — 0.2.1's "执行了命令，已调用工具…" summary —
			// so it folds away instead of becoming a category of its own.
			if (!answer && reasoning === '') partHidden.push(key)
			continue
		}

		if (node.kind === 'tool-call') {
			const name = toolNameOf(node)
			const category = ensure('tool:' + name, name, false)
			const data = dataOf(node)
			const root = data === null ? null : data.root
			const running = toolRunning(root)
			// A shell failure is result DATA, not `isError`: the executor settles a non-zero
			// exit as a completed call and leaves the status in the output marker. Without
			// reading it, a failing command counts as a success here.
			const exit = running ? null : exitStatusOf(name, root)
			const exitFailed = exit !== null && (exit.signal !== undefined || (typeof exit.code === 'number' && exit.code !== 0))
			const toolFailed = !running && root !== null && root !== undefined && root.isError === true
			const failed = toolFailed || exitFailed
			// When the call started: a settled result records `callTime`, a running one
			// records `time`. Grouping by kind flattens the timeline, so every item keeps
			// its own clock position for the reader to re-assemble it.
			const startedAt = root === null || root === undefined
				? undefined
				: typeof root.callTime === 'number' ? root.callTime : typeof root.time === 'number' ? root.time : undefined
			category.nodes.push(key)
			category.count += 1
			category.durationMs += durationMsOf(root)
			if (startedAt !== undefined) {
				// First and last call of the category, for the hover range on Σ.
				if (category.firstAt === undefined || startedAt < category.firstAt) category.firstAt = startedAt
				if (category.lastAt === undefined || startedAt > category.lastAt) category.lastAt = startedAt
			}
			totals.calls += 1
			if (running) {
				category.running += 1
				totals.running += 1
				// The oldest call of the category drives its highlight age.
				if (startedAt !== undefined && (category.runningSince === undefined || startedAt < category.runningSince)) category.runningSince = startedAt
				if (totals.runningNames.indexOf(name) < 0) totals.runningNames.push(name)
			} else if (failed) {
				category.failed += 1
				totals.failed += 1
				// Collect every distinct failure reason instead of letting the last one win:
				// a category may mix `exit 1`, `exit 2` and a signal, and reporting only the
				// last would misstate what happened.
				const reason = exitLabelOf(exit) !== '' ? exitLabelOf(exit) : errorShortOf(root)
				if (reason !== '') category.reasons.set(reason, (category.reasons.get(reason) ?? 0) + 1)
			} else {
				category.ok += 1
				totals.ok += 1
			}
			const content = root !== null && root !== undefined && Array.isArray(root.content) ? root.content : null
			ordinal += 1
			category.items.push({
				type: 'tool',
				ordinal,
				key,
				name,
				preview: argsSummary(root),
				state: running ? 'running' : failed ? 'error' : 'ok',
				// `exit 2` / `signal SIGKILL` raised on the row itself, so a failed command
				// is visible without opening the item.
				exitLabel: exitFailed ? exitLabelOf(exit) : '',
				startedAt,
				duration: durationOf(root),
				// Running calls carry their start time instead of a duration, so a
				// long delegation (a subagent, a background shell) can report elapsed
				// time without this renderer owning a timer.
				since: running && startedAt !== undefined ? startedAt : undefined,
				body: toolBodyOf(root),
				images: imagesFromBlocks(content),
			})
			continue
		}

		let groupKey = 'kind:' + String(node.kind)
		let label = String(node.kind)
		if (node.kind === 'context') {
			groupKey = 'context'
			label = tr(t, 'message.contextInjection', undefined, FALLBACK.context)
		} else if (node.kind === 'model-retry') {
			groupKey = 'retry'
			label = tr(t, 'message.retry', undefined, FALLBACK.retry)
		} else if (node.kind === 'command' || node.kind === 'command-input') {
			groupKey = 'command'
			label = FALLBACK.command
		} else if (node.kind === 'compaction' || node.kind === 'manual-compaction') {
			groupKey = 'compaction'
			label = FALLBACK.compaction
		} else if (node.kind === 'workflow-run') {
			groupKey = 'workflow'
			label = FALLBACK.workflow
		} else if (node.kind === 'turn-trigger') {
			// 0.2.1: what started an automatically triggered Turn (goal round, schedule,
			// job, webhook, plugin notice). It explains the Turn, so it folds rather than
			// disappears, and the item text is its own trigger label.
			groupKey = 'trigger'
			label = FALLBACK.trigger
		} else if (KNOWN_PROCESS_KINDS[node.kind] !== true) {
			warnUnknownKind(node.kind)
		}
		const category = ensure(groupKey, label, false)
		category.nodes.push(key)
		category.count += 1
		const body = node.kind === 'context' ? textFromBlocks(blocksOf(node), 'text').trim() : ''
		ordinal += 1
		category.items.push({
			type: 'text',
			ordinal,
			key,
			name: node.kind === 'context' && labelOf(node) !== null ? labelOf(node) : label,
			startedAt: startedAtOf(node),
			preview: body.replace(/\s+/g, ' ').slice(0, 200),
			body: clip(body),
			images: imagesFromBlocks(blocksOf(node)),
		})
	}

	const shown = []
	const hidden = []
	for (const category of categories) {
		category.errorShort = summarizeReasons(category.reasons)
		shown.push(category)
		for (const key of category.nodes) hidden.push(key)
	}
	return { categories: shown, hidden: hidden.concat(partHidden), inlineThinkKeys, totals }
}

/** Summary line copy for one Turn. */
function summaryLabel(spec, totals, live, t) {
	const separator = tr(t, 'message.turnProcess.separator', undefined, FALLBACK.separator)
	const toolCalls = (count) => tr(t, count === 1 ? 'message.turnProcess.toolCalls.one' : 'message.turnProcess.toolCalls.other', { count }, FALLBACK.toolCalls)
	const messages = (count) => tr(t, count === 1 ? 'message.turnProcess.messages.one' : 'message.turnProcess.messages.other', { count }, FALLBACK.messages)
	const subagents = (count) => tr(t, count === 1 ? 'message.turnProcess.subagents.one' : 'message.turnProcess.subagents.other', { count }, FALLBACK.subagents)
	const parts = []
	if (live) {
		const running = totals.runningNames.length === 0
			? FALLBACK.thinking
			// Several concurrent calls (parallel subagents, parallel shells) say so.
			: FALLBACK.running + ' ' + totals.runningNames.join('、') + (totals.running > 1 ? ' ×' + totals.running : '')
		parts.push(running)
		if (totals.calls > 0) parts.push(toolCalls(totals.calls))
	} else {
		if (spec.toolCallCount > 0) parts.push(toolCalls(spec.toolCallCount))
		if (spec.messageCount > 0) parts.push(messages(spec.messageCount))
		if (spec.subagentCount > 0) parts.push(subagents(spec.subagentCount))
		if (parts.length === 0) parts.push(tr(t, 'message.turnProcess.thoughtForAWhile', undefined, FALLBACK.thought))
	}
	return parts.join(separator)
}

/**
 * Row key of one Node part.
 *
 * The Chat flow renders one Node as one row per `groupPart`; only an absent or
 * `response` part keeps the plain Node key, every other part is keyed
 * `JSON.stringify([key, part])`. A reasoning row is therefore not addressable by
 * its Node key at all.
 * @param key - stable Chat Node key.
 * @param part - `groupPart` value.
 * @returns the row's `data-chat-anchor-key` value.
 */
function partKeyOf(key, part) {
	return JSON.stringify([String(key), part])
}

/** Attribute selector for one stable Chat Node key. */
function attributeSelector(key) {
	let escaped = ''
	const text = String(key)
	for (const character of text) {
		if (character === '\\' || character === '"') escaped += '\\' + character
		else escaped += character
	}
	return '[data-chat-anchor-key="' + escaped + '"]'
}

/**
 * Stylesheet body hiding folded rows and inline reasoning.
 *
 * Hidden rows use their stable anchor key. Reasoning gets two guards: the
 * node-scoped rule, and a Turn-scoped fallback in case a reasoning row is
 * composed under a wrapper the node rule cannot see (for example a step row
 * the shipping Chat re-parents).
 * @param hidden - anchor keys of the folded rows.
 * @param inlineThinkKeys - anchor keys of reply rows carrying reasoning.
 * @param turn - owning Turn number, for the scoped fallback.
 * @returns stylesheet text, or null when nothing is folded.
 */
function rulesFor(hidden, inlineThinkKeys, turn) {
	const rules = []
	for (const key of hidden) rules.push(attributeSelector(key) + '{display:none}')
	for (const key of inlineThinkKeys) rules.push(attributeSelector(key) + ' [data-variant="think"]{display:none}')
	if (inlineThinkKeys.length > 0 && typeof turn === 'number') rules.push('[data-chat-turn="' + turn + '"] [data-variant="think"]{display:none}')
	return rules.length === 0 ? null : rules.join('\n')
}

/** One durable image thumbnail, expandable to a full-screen view. */
function Thumb(props) {
	const loadImage = props.loadImage
	const [url, setUrl] = React.useState(() => {
		if (typeof loadImage === 'function' && typeof loadImage.peek === 'function') {
			try {
				const cached = loadImage.peek(props.attachment)
				if (typeof cached === 'string' && cached !== '') return cached
			} catch (error) {
				console.error('aura-cardea: image peek failed', error)
			}
		}
		return null
	})
	const [zoomed, setZoomed] = React.useState(false)
	React.useEffect(() => {
		if (url !== null) return undefined
		if (typeof loadImage !== 'function') return undefined
		let active = true
		let pending = null
		try {
			pending = loadImage(props.attachment)
		} catch (error) {
			console.error('aura-cardea: image load failed', error)
			return undefined
		}
		if (pending !== null && typeof pending.then === 'function') {
			pending.then((value) => {
				if (active && typeof value === 'string' && value !== '') setUrl(value)
			}, (error) => {
				console.error('aura-cardea: image load failed', error)
			})
		}
		return () => {
			active = false
		}
	}, [url, loadImage, props.attachment])
	if (url === null) return React.createElement('span', { className: 'dcg-thumb-pending' }, '图片加载中…')
	const label = props.name === '' ? '图片' : props.name
	const thumb = React.createElement('img', {
		className: 'dcg-thumb',
		src: url,
		alt: label,
		title: '双击放大',
		onDoubleClick: () => setZoomed(true),
	})
	if (!zoomed) return thumb
	const zoom = React.createElement('div', {
		className: 'dcg-zoom',
		role: 'presentation',
		onClick: () => setZoomed(false),
		onDoubleClick: () => setZoomed(false),
	},
		React.createElement('button', {
			type: 'button',
			className: 'dcg-zoom-close',
			onClick: (event) => {
				event.stopPropagation()
				setZoomed(false)
			},
			'aria-label': '关闭',
		}, '×'),
		React.createElement('img', {
			className: 'dcg-zoom-img',
			src: url,
			alt: label,
			onClick: (event) => event.stopPropagation(),
			onDoubleClick: (event) => {
				event.stopPropagation()
				setZoomed(false)
			},
		}),
		React.createElement('span', { className: 'dcg-zoom-hint' }, '点击空白处或双击图片关闭'),
	)
	return React.createElement(React.Fragment, null, thumb, zoom)
}

/** One call (or reasoning/context entry) inside an expanded category. */
function ItemRow(props) {
	const item = props.item
	const [open, setOpen] = React.useState(false)
	const hasBody = typeof item.body === 'string' && item.body.trim() !== ''
	const expanded = hasBody && open
	const properties = {
		type: 'button',
		className: 'dcg-item',
		'data-open': expanded ? '' : undefined,
		'data-running': item.state === 'running' ? '' : undefined,
		'data-age': item.state === 'running' ? runningAge(item.since) : undefined,
	}
	if (hasBody) {
		properties.onClick = () => setOpen((value) => !value)
		properties['aria-expanded'] = expanded
	} else {
		properties['data-static'] = ''
	}
	let mark = React.createElement('span', { className: 'dcg-item-mark', 'data-state': 'text', 'aria-hidden': 'true' }, '·')
	let time = ''
	const clock = formatClock(item.startedAt)
	if (item.type === 'tool') {
		mark = React.createElement('span', { className: 'dcg-item-mark', 'data-state': item.state, 'aria-hidden': 'true' }, item.state === 'running' ? React.createElement(RunningKeys) : item.state === 'ok' ? '✓' : '✗')
		// A settled call reports its duration; a running one reports elapsed time,
		// recomputed on every re-render, so a long subagent delegation stays legible.
		time = item.duration !== '' ? item.duration : typeof item.since === 'number' ? '已运行 ' + formatDuration(Date.now() - item.since) : ''
	}
	const thumbs = []
	const images = Array.isArray(item.images) ? item.images : []
	for (let index = 0; index < images.length; index += 1) {
		thumbs.push(React.createElement(Thumb, {
			key: 'image:' + index,
			attachment: images[index].attachment,
			name: images[index].name,
			loadImage: props.loadImage,
		}))
	}
	return React.createElement(React.Fragment, null,
		React.createElement('button', properties,
			mark,
			// The Turn's own process order, so grouping by kind stays readable across
			// categories; a timeline view would only re-sort the same numbers.
			typeof item.ordinal === 'number' ? React.createElement('span', { className: 'dcg-item-ord' }, '#' + item.ordinal) : null,
			React.createElement('span', { className: 'dcg-item-name' }, item.name),
			item.exitLabel === undefined || item.exitLabel === '' ? null : React.createElement('span', { className: 'dcg-item-exit', title: '命令退出状态' }, item.exitLabel),
			item.preview === undefined || item.preview === null || item.preview === '' ? null : React.createElement('span', { className: 'dcg-item-text' }, item.preview),
			// Clock position first, then how long it took: grouping by kind loses the
			// interleaving between categories, so each row carries its own time.
			clock === '' ? null : React.createElement('span', { className: 'dcg-item-clock', title: '调用时间' }, clock),
			time === '' ? null : React.createElement('span', { className: 'dcg-item-time' }, time),
			hasBody ? React.createElement('span', { className: 'dcg-item-chevron', 'aria-hidden': 'true' }, expanded ? '⌃' : '⌄') : null,
		),
		thumbs.length === 0 ? null : React.createElement('div', { className: 'dcg-thumbs' }, thumbs),
		expanded ? React.createElement('div', { className: 'dcg-body' }, item.body) : null,
	)
}

/** Expanded item list of one category, capped unless the reader asks for all. */
function CategoryBody(props) {
	const [showAll, setShowAll] = React.useState(false)
	const items = Array.isArray(props.group.items) ? props.group.items : []
	const visible = showAll || items.length <= ITEM_LIMIT ? items : items.slice(0, ITEM_LIMIT)
	const rows = []
	for (const item of visible) {
		rows.push(React.createElement(ItemRow, { key: item.key, item, loadImage: props.loadImage }))
	}
	const hiddenCount = items.length - visible.length
	if (hiddenCount > 0) {
		rows.push(React.createElement('button', {
			key: ':more',
			type: 'button',
			className: 'dcg-more',
			onClick: () => setShowAll(true),
		}, '还有 ' + hiddenCount + ' 条'))
	}
	return React.createElement('div', { className: 'dcg-items' }, rows)
}

/** One category header: label, count, stats, total duration, running marker. */
function CategoryRow(props) {
	const group = props.group
	const open = props.open
	const duration = formatDuration(group.durationMs)
	return React.createElement('button', {
		type: 'button',
		className: 'dcg-cat',
		'data-open': open ? '' : undefined,
		'data-running': group.running > 0 ? '' : undefined,
		'data-age': group.running > 0 ? runningAge(group.runningSince) : undefined,
		'data-category': group.key,
		'aria-expanded': open,
		onClick: props.onToggle,
	},
		chevron(open),
		React.createElement('span', { className: 'dcg-cat-label' }, group.label),
		React.createElement('span', { className: 'dcg-cat-count' }, '×' + group.count),
		group.ok > 0 ? React.createElement('span', { className: 'dcg-stats' }, React.createElement('span', { className: 'dcg-ok' }, '✓' + group.ok)) : null,
		group.failed > 0 ? React.createElement('span', { className: 'dcg-stats' }, React.createElement('span', { className: 'dcg-fail' }, '✗' + group.failed)) : null,
		group.errorShort === '' ? null : React.createElement('span', { className: 'dcg-cat-error', title: reasonTitle(group.reasons) }, group.errorShort),
	duration === '' ? null : React.createElement('span', {
		className: 'dcg-cat-duration',
		// Hovering the sum tells the reader where this kind sat in the Turn.
		title: typeof group.firstAt === 'number' && typeof group.lastAt === 'number'
			? formatClock(group.firstAt) + ' → ' + formatClock(group.lastAt)
			: undefined,
	}, 'Σ ' + duration),
		group.running > 0 ? React.createElement('span', { className: 'dcg-cat-live' }, React.createElement(RunningKeys), FALLBACK.liveSuffix) : null,
	)
}

/**
 * Keyed `conversation.chat.node` renderer for `turn-process`.
 *
 * Renders the summary line plus one row per process category, and hides the
 * folded rows through a private stylesheet keyed on their anchor attribute.
 */
function TurnStatusView(props) {
	const spec = dataOf(props.node)
	const turnProcess = props.turnProcess
	const useChat = props.useChat
	const order = typeof useChat === 'function' ? useChat((snapshot) => snapshot.order) : undefined
	const store = typeof useChat === 'function' ? useChat((snapshot) => snapshot.nodes) : undefined
	const [expanded, setExpanded] = React.useState({})
	// Hooks must run in the same order on every render, so both live above the
	// null-spec guard. A quiet Turn (one long command, one slow subagent) emits no
	// events, so elapsed time and the age ramp would freeze without this tick.
	const [, setTick] = React.useState(0)
	const runningRef = React.useRef(false)
	React.useEffect(() => {
		const timer = setInterval(() => { if (runningRef.current) setTick((value) => value + 1) }, 15000)
		return () => clearInterval(timer)
	}, [])
	if (spec === null) return null
	const foldable = turnProcess !== undefined && turnProcess !== null && turnProcess.foldable === true
	const closed = turnClosedOf(props.node)
	// collectProcess no longer varies with the live flag (every non-answer row folds),
	// so one collection feeds both the label and the rules.
	const collected = collectProcess(spec, order, store, props.t)
	runningRef.current = collected.totals.running > 0
	// Running is decided by evidence, not by one status field: an unsettled Tool call
	// is live, otherwise a Turn whose location is not provably closed is live.
	// The shipped `foldable` flag wins for closed Turns in compact mode.
	const live = !foldable && (collected.totals.running > 0 || closed !== true)
	const groups = collected.categories
	if (!live && groups.length === 0) return null
	const toggleGroup = (key) => {
		setExpanded((current) => {
			const next = {}
			for (const currentKey of Object.keys(current)) next[currentKey] = current[currentKey]
			next[key] = current[key] !== true
			return next
		})
	}
	const allExpanded = groups.length > 0 && groups.every((group) => expanded[group.key] === true)
	const toggleAll = () => {
		if (allExpanded) {
			setExpanded({})
			return
		}
		const next = {}
		for (const group of groups) next[group.key] = true
		setExpanded(next)
	}
	const rules = rulesFor(collected.hidden, collected.inlineThinkKeys, spec.turn)
	const children = [
		React.createElement('button', {
			key: 'summary',
			type: 'button',
			className: 'dcg-proc',
			'data-open': allExpanded ? '' : undefined,
			'data-turn-status': live ? (collected.totals.running > 0 ? 'running' : 'idle') : 'done',
			'data-dcg-turn': String(spec.turn),
			'data-dcg-build': BUILD,
			'aria-expanded': allExpanded,
			onClick: groups.length === 0 ? undefined : toggleAll,
		},
			React.createElement('span', { className: 'dcg-proc-dot', 'aria-hidden': 'true' }),
			React.createElement('span', { className: 'dcg-proc-label' }, summaryLabel(spec, collected.totals, live, props.t)),
			collected.totals.ok > 0 ? React.createElement('span', { className: 'dcg-stats' }, React.createElement('span', { className: 'dcg-ok' }, '✓' + collected.totals.ok)) : null,
			collected.totals.failed > 0 ? React.createElement('span', { className: 'dcg-stats' }, React.createElement('span', { className: 'dcg-fail' }, '✗' + collected.totals.failed)) : null,
			groups.length === 0 ? null : chevron(allExpanded),
		),
	]
	if (groups.length > 0) {
		const rows = []
		for (const group of groups) {
			const open = expanded[group.key] === true
			rows.push(React.createElement(CategoryRow, {
				key: group.key,
				group,
				open,
				onToggle: () => toggleGroup(group.key),
			}))
			if (open) {
				rows.push(React.createElement(CategoryBody, {
					key: group.key + ':items',
					group,
					loadImage: props.loadImage,
				}))
			}
		}
		children.push(React.createElement('div', { key: 'categories', className: 'dcg-cats' }, rows))
	}
	if (rules !== null) children.push(React.createElement('style', { key: 'rules' }, rules))
	return React.createElement(React.Fragment, null, children)
}

/**
 * Mount the client half: own the stylesheet and take the `turn-process` cell.
 * @param ctx - owning Cordis context.
 */
function apply(ctx) {
	ctx.effect(() => {
		const tag = document.createElement('style')
		tag.dataset.plugin = 'aura-cardea'
		tag.textContent = CSS
		document.head.appendChild(tag)
		return () => {
			if (tag.parentNode !== null) tag.parentNode.removeChild(tag)
		}
	}, 'aura-cardea: stylesheet')

	console.info('aura-cardea ' + BUILD + ' loaded (apply ran)')
	ctx.inject(['slots'], (slotted) => {
		try {
			slotted.slots.inject('conversation.chat.node', () => slotted.slots.register({ name: 'conversation.chat.node', key: 'turn-process', locale: 'chat' }, TurnStatusView))
		} catch (error) {
			console.error('aura-cardea: locale-bound registration failed, retrying without a locale', error)
			slotted.slots.inject('conversation.chat.node', () => slotted.slots.register({ name: 'conversation.chat.node', key: 'turn-process' }, TurnStatusView))
		}
	})
}

		exports.apply = apply
		return module.exports
	},
})
