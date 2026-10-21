/**
 * Host half of `aura-cardea` (AuraCardea).
 *
 * The feature is entirely a browser capability: it replaces the Chat
 * `turn-process` node renderer with a per-kind fold (tool calls, reasoning,
 * context injections, retries) that also hides the folded rows. The Host
 * therefore registers nothing — this module exists so the Loader has a row to
 * mount, which is what makes `dsh.client` discoverable and puts the bundle
 * behind `/plugins`.
 */

/** Mount marker: nothing to register on the Host. */
export function apply() {}
