# 退休件存放处（`aura-tools/docs/archive/`）

这里**不是垃圾场**，是**退休件**的存放处。每一件都曾经在台上干过活：被裁定退休之后**原样搬进来冻结**
（正文一字不改，只在顶部注释追加一段退休说明），留着只为可回溯 —— 「它当时问什么、怎么问的、为什么不再问」。

## 入库规矩

1. **有裁定才入库**。谁、哪一天、依据什么（用户裁定 / 施工单号）裁定退休 —— 写进件顶部注释，也写进下面这张台账。
2. **原样冻结**。正文一个字都不改；冻结之后**不再维护、不再进闸、不再修**。要改就是新写一件，不是回来改它。
3. **写明接班人**。退休不等于这个问题没人管了：问题还在、只是换了尺子 ⇒ 写出接班的件；问题已解决或已判定
   不值得再问 ⇒ 写出结论与判据来源。
4. **不参与判定**。这里的东西**不**参加 `build/release-check.mjs` 的普查（§⑩「普查完整性」）。普查的扫描根是
   `aura-tools/**`，其中 `docs/archive/**` 被**显式跳过**（`SKIP_NESTED`，注释里写明谁扫、扫到几件、为什么不判）：
   跳过件数与 `dist/ fixtures/ node_modules/` 一起印在「完整性」/「口径」两行的“未扫”读数里 —— 是记在账上的跳过，
   不是“悄悄少扫一个目录”。
5. **代价如实声明**：件里的相对 import（`../src/...`）与 `REPO` 都是按它在 `probes/` 时的位置算的，搬到这里之后
   **不再可跑**。这是冻结的代价，不是待修的缺陷。真要重跑，取回**原路径那一份**：本件当时**未被 git 跟踪**（`git ls-files aura-tools/probes` 只有 7 件，不含它），所以 git 历史里取不到 —— 可用的替身有两份，都逐字节可核：① 本目录这份去掉顶部追加的那段说明后即原文（移动前 sha256 `c9a6b944c6ce5bf1…`，全文 28001 B）；② 移动前的一次只读快照 `.polaris/verify-c37/tree/aura-tools/probes/residual-recheck.mjs`（sha256 同为 `c9a6b944c6ce5bf1…`）。

## 台账

### 1. `probes/residual-recheck.mjs` —— 2026-10-16 退休（用户裁定）

- **它原来问什么**：R1 残余的**独立复算** —— 不 import 被复算的探针，从零重写 `residual-census.mjs` 那条流水线
  （语料 → 重放原文 → 三态路由 → 机制阶梯 → X），再拿自己的读数与测量方产出的 `--json` **逐格对账**；另加三件测量：
  第二把尺子（直接问 `expectVerdict`）、hunk 变体顺序不变量（`[old, old+context]` 两种顺序分桶是否一致）、
  第四个 X 口径（`X_firstline` / 按标签直算的 `X_norm_true`）。
- **为什么退休（它为什么是空判）**：判定挂在 `tmp/recheck-r1-json.txt` 这份**一次性产物**上。产物在，才逐格对账；
  产物不在，它自己印一句「测量方 JSON 缺席，未做逐格对账」（`:501`），而退出码是
  `process.exit(assertMode && differ.length > 0 ? 1 : 0)`（`:543`）—— 没有产物就没有 `differ` ⇒ **exit 0**。
  C37 当次跑就是这个结果：绿得毫无信息量。**它为什么不是回归线**：它判的是“这一次那一份产物与现树读数逐格相符”，
  产物缺席时判据根本不存在 —— 一条随产物出现/消失而有无的判据，进闸只会给一个恒真的绿，把“没判”伪装成“判过了”。
- **谁来接班**：
  - 残余逐格读数这条线 —— `probes/residual-census.mjs`（今天的测量线，六格 143/147/15/27/17/4 逐格对账）与上游
    `src/locator-lab/failure-replay.mjs`（`SUITES` 在册、退出码表态）；两件都从**现场**取数，不依赖一次性产物。
  - 「工具行为」的真不变式 —— `src/locator-lab/notfound-receipt-test.mjs`、`src/locator-lab/already-applied-test.mjs`
    （不许误判 / 磁盘不动 / 幂等）、`src/locator-lab/handle-edit-test.mjs`，都在 `SUITES` 里逐条钉住。
  - “独立复算”这个角色本身 —— 同源的普查/审计件（`address-form-census` / `already-applied-census` / `quote-hygiene`）
    已改成 import 上游导出的 `replayNewContract`，与上游活读数逐格对账；不再由一件挂在一次性产物上的复算器承担。
  - 探针台账里的那条豁免 —— `build/release-check.mjs` 的 `CENSUS_EXEMPT` 里已改成一条**退休记录**注释
    （`// C2 改理由：…`），条目从豁免名单删掉：件不在了，清单不该再点它的名。
