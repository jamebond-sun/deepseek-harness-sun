/** 在其调用方触碰 profile 之前，等待某个包运行的进程树消失。 */

/** 已终止的树在调用方停止等待之前、可能花在消失上的时间。 */
const TREE_WAIT_MS = 5_000

/** 等待已终止的树消失时的轮询节奏。 */
const TREE_POLL_MS = 15

/** 一次运行所占用的进程（或进程组）。 */
export interface RunTree {
  /** 运行的进程 id，在其 spawn 公布了它时。 */
  pid: number | undefined
  /** 运行是否带领自己的进程组，这正是 POSIX 组探测所针对的目标。 */
  grouped: boolean
}

/** 可注入的进程操作，使每个平台的探测都可在任意宿主上测试。 */
export interface RunTreeInternals {
  /** 用于目标判定的宿主平台覆盖值。 */
  platform?: NodeJS.Platform
  /** 存活探测覆盖值，默认是 `process.kill(target, 0)`。 */
  alive?: (target: number) => boolean
  /** 等待上限覆盖值，默认是树等待常量。 */
  waitMs?: number
}

/**
 * 一次运行是否带领自己的进程组，这正是 POSIX 存活探测针对整棵树的那个目标。捕获输出的
 * 运行会作为自己的组领导者被 spawn，因为它的树是作为一个整体被终止的；继承调用方
 * 描述符的运行则保留调用方的组，因此中断仍能抵达它。
 * @param execution 运行是捕获输出，还是继承调用方的描述符。
 * @param platform 决定树如何被寻址的宿主平台。
 * @returns 当运行带领自己的进程组时为 true。
 */
export function leadsOwnGroup(execution: 'cli' | 'service', platform: NodeJS.Platform = process.platform): boolean {
  return execution === 'service' && platform !== 'win32'
}

/** 树探测所寻址的目标：当运行带领一个组时为 POSIX 组，否则为进程自身。 */
function targetOf(pid: number, grouped: boolean, platform: NodeJS.Platform): number {
  return platform !== 'win32' && grouped ? -pid : pid
}

/**
 * 运行的树中是否还有成员存活。
 * @param tree 运行的进程 id，以及它是否带领自己的组。
 * @param internals 可注入的进程操作。
 * @returns 当探测找到进程或某个组成员时为 true。
 */
export function treeAlive(tree: RunTree, internals: RunTreeInternals = {}): boolean {
  const pid = tree.pid
  if (pid === undefined) return false
  const platform = internals.platform ?? process.platform
  const alive = internals.alive ?? ((target: number) => { process.kill(target, 0); return true })
  try {
    return alive(targetOf(pid, tree.grouped, platform))
  } catch {
    return false
  }
}

/**
 * 等待直到已终止运行的树消失，从而使调用方仅在该运行所启动的脚本停止写入之后，
 * 才恢复并解锁 profile。
 * @param tree 运行的进程 id，以及它是否带领自己的组。
 * @param internals 可注入的进程操作。
 * @returns 当不再有成员残留、或等待上限经过时兑现。
 */
export async function awaitTreeGone(tree: RunTree, internals: RunTreeInternals = {}): Promise<void> {
  const deadline = Date.now() + (internals.waitMs ?? TREE_WAIT_MS)
  while (treeAlive(tree, internals)) {
    if (Date.now() >= deadline) return
    await new Promise(resolve => setTimeout(resolve, TREE_POLL_MS))
  }
}
