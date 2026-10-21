/**
 * 本页面上次读取到的 host 定义注册表，由插件的 apply 闭包持有。
 *
 * 该面板是一个全框架表面，因此它无法从任何会话派生此内容：
 * 注册表是全局的，而读取是一次单一的全局调用。各行被
 * 重新读取而非打补丁，因为连线公告
 * （`cordis/dynamic-package` / `/retract`）不携带任何标签，而一个定义
 * 可能在它们之间出现或消失 —— 就地打补丁的缓存会漂移到
 * 显示 host 不再持有的定义。
 *
 * 读取是单飞的：若干同时结算的公告，或一个徽标
 * 在重连重读时打开，都不能让该调用倍增。但仅有单飞
 * 在跨重连时仍属错误 —— 在途的读取属于
 * 上一次连接，因此一次 reset 既丢弃其应答，又释放槽位
 * 以进行全新的一次。否则，一次重连要么把其重读丢失给旧
 * 调用，要么让旧 host 的行覆盖在它之上。
 */

import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { CordisDynamicPort, CordisInventoryRow } from './dynamic-port.ts'
import type { CordisDynamicPluginId } from './events.ts'

/** 面板所读取的内容：各行，以及首次读取是否已发生。 */
export interface CordisInventorySnapshot {
  readonly rows: readonly CordisInventoryRow[]
  /** 通过本页面显式移除的 Plugin，为历史卡片保留。 */
  readonly removed: ReadonlySet<CordisDynamicPluginId>
  /**
   * 在读取结算之前为 false。面板显示一行加载提示而非
   * 空状态，因此在已知之前绝不声称"尚未定义任何内容"。
   */
  readonly read: boolean
  /** 上次读取失败，以便面板说明它为何为空。 */
  readonly error?: string | undefined
}

/** 清单来源：各行的可观察对象，外加读取触发器。 */
export interface CordisInventory extends HostObservable<CordisInventorySnapshot> {
  /** 除非已有读取在途，否则读取注册表。 */
  refresh(): void
  /** 记录一次显式移除，并立即丢弃活动行。 */
  retire(pluginId: CordisDynamicPluginId): void
  /** 丢弃已读取的内容；下一次刷新从零开始（重连可能是一个新的 host）。 */
  reset(): void
}

/**
 * 创建清单来源。
 * @param port - 读取所经由的 RPC 接缝。
 * @param onError - 失败读取的报告器（生产环境为 console，规格中则被捕获）。
 * @returns 清单可观察对象及其读取触发器。
 */
export function createCordisInventory(
  port: CordisDynamicPort,
  onError: (error: unknown) => void,
): CordisInventory {
  const listeners = new Set<() => void>()
  let snapshot: CordisInventorySnapshot = { rows: [], removed: new Set(), read: false }
  let inFlight: Promise<void> | undefined
  // 由 reset 递增；代际已过期的读取不会发布任何内容。
  let generation = 0

  const publish = (next: CordisInventorySnapshot): void => {
    snapshot = next
    for (const listener of [...listeners]) listener()
  }

  return {
    getSnapshot: () => snapshot,
    subscribe: (fn) => {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    },
    refresh: () => {
      if (inFlight !== undefined) return
      const issued = generation
      inFlight = port.inventory().then(
        (rows) => {
          if (issued !== generation) return
          const removed = new Set(snapshot.removed)
          const live = new Set(rows.map(row => row.pluginId))
          for (const previous of snapshot.rows) {
            if (!live.has(previous.pluginId)) removed.add(previous.pluginId)
          }
          publish({ rows, removed, read: true })
        },
        (error: unknown) => {
          if (issued !== generation) return
          onError(error)
          // 一次失败的读取保留已显示的内容并说明原因：丢弃
          // 各行会把一次瞬时的连线失败变成"没有任何定义"。
          publish({
            rows: snapshot.rows,
            removed: snapshot.removed,
            read: snapshot.read,
            error: error instanceof Error ? error.message : 'reading the cordis inventory failed',
          })
        },
      ).then(() => { if (issued === generation) inFlight = undefined })
    },
    retire: (pluginId) => {
      const removed = new Set(snapshot.removed)
      removed.add(pluginId)
      publish({ ...snapshot, rows: snapshot.rows.filter(row => row.pluginId !== pluginId), removed })
    },
    reset: () => {
      generation += 1
      inFlight = undefined
      publish({ rows: [], removed: snapshot.removed, read: false })
    },
  }
}
