/**
 * mock-ctx.mjs —— 与真实 Cordis 上下文同形的 mock 片段。
 *
 * ## 为什么需要它
 *
 * 原来的测试 mock 只有 `tools` / `systemPrompt` / `emit` / `waterfall`，而真实的
 * Cordis 上下文**还有 `inject` 与 `get`**。mock 比框架宽松，就等于没测那一部分：
 *
 *   `aura_edit` 曾用 `ctx.get('sandboxPolicy')` 取沙箱策略，而全部测试 mock 都没有
 *   `get`，于是"取不到就降级"这条路径在测试里永远走通，生产里却抛
 *   `TypeError: ctx.get is not a function`。更早一次同性质的漏测更贵：mock 的
 *   `editText` 只声明两个参数，而真实签名是五个（`target, edit, expected, signal,
 *   sandboxPolicy`），于是"漏传沙箱策略"这个必然导致**写盘全被拒**的 bug
 *   在 41/41 全绿的测试里安然穿过。
 *
 * 结论：mock 必须与被它替代的东西**同形**，缺一个成员就是缺一条被测路径。
 *
 * @param policies - 本 mock 要暴露的可选服务（如 `{ sandboxPolicy }`）；不给则什么都不注入。
 * @returns `inject` 与 `get` 两个成员，展开进任意 mock 上下文对象。
 */
export function contextServices(policies = {}) {
  return {
    /**
     * 与 Cordis 同形：只有声明的依赖**全部**在场时才调用回调。
     * 少一个在场条件，就会测出生产里不存在的"服务存在"路径。
     */
    inject: (deps, fn) => {
      if (deps.every((d) => policies[d] !== undefined)) fn({ ...policies })
    },
    /** 与 Cordis 同形：未注册的服务取到 undefined，而不是抛错。 */
    get: (name) => policies[name],
  }
}
