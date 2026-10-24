/**
 * pkg-root.mjs —— 包根的**唯一来源**：从本文件位置向上走，找到同时含
 * `build/make-bundle.mjs` 与 `src/locator-lab/read-core.mjs` 的那一层目录。
 *
 * 为什么要有它：套件里曾经把**包目录名**写死（`path.join(REPO, 'aura-tools', …)`）。
 * 那只在目录恰好叫 `aura-tools` 时成立 —— 仓 clone 到任何别的名字（`aura-basetools`、
 * `rb-xxxx`、任意随机名）就 ENOENT。包根是**文件位置的事实**，不是目录名的约定。
 *
 * 用法：
 *   import { pkgRoot, pkgPath } from '../build/pkg-root.mjs'   // probes/ 下
 *   import { pkgRoot, pkgPath } from '../../build/pkg-root.mjs' // src/<dir>/ 下
 *
 *   pkgPath('src', 'locator-lab')          // <包根>/src/locator-lab
 *   pkgPath('fixtures', 'frozen-…')        // <包根>/fixtures/frozen-…
 *
 * `dist/` 的**产物目录名**（`dist/<包名>`）仍由 `build/make-bundle.mjs` 决定；
 * 需要它的套件直接读 `dist/aura-basetools/package.json`，不要在本文件里再抄一份。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 两个标记缺一不可：只要 `build/`（任意含 make-bundle 的项目）或只要 `src/locator-lab`（引擎副本/冻结件）都可能是冒牌祖先。 */
const MARKERS = [path.join('build', 'make-bundle.mjs'), path.join('src', 'locator-lab', 'read-core.mjs')]

/** 从 `start` 起向上找第一个同时含两个标记的目录；走到根还没有就抛（宁可炸，不准猜）。 */
function findPkgRoot(start) {
  let dir = path.resolve(start)
  for (;;) {
    if (MARKERS.every((rel) => fs.existsSync(path.join(dir, rel)))) return dir
    const up = path.dirname(dir)
    if (up === dir) {
      throw new Error(
        `pkg-root: 从 ${start} 向上找不到包根（需同时含 ${MARKERS.join(' 与 ')}）—— ` +
          '本文件被复制到了包外，或包体缺了构建标记。',
      )
    }
    dir = up
  }
}

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** 包根的绝对路径（本文件在 `<包根>/build/pkg-root.mjs`，故从上一级起找）。 */
export const pkgRoot = findPkgRoot(path.resolve(HERE, '..'))

/** 包根下的路径：`pkgPath('dist', ...)` ⇒ `<包根>/dist/...`。 */
export const pkgPath = (...segs) => path.join(pkgRoot, ...segs)
