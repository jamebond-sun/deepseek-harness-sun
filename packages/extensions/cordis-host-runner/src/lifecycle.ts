/**
 * 在 `cordis-dynamic` 组之上的宿主半区纤程生命周期：把沙箱产出的插件
 * 落定为一个子纤程（绝不留下一个已挂载的失败纤程），并报告一个已落定但尚未就绪的
 * 纤程仍在等待的服务。停止不需要辅助函数——一个宿主半区经由一次普通的
 * 被 await 的 `fiber.dispose()` 展开，因为插件注册的一切都是
 * 它纤程上的一个效应。
 * @module @deepseek-ai/dsh-cordis-host-runner/lifecycle
 */

import type { Context, Fiber, Plugin } from '@deepseek-ai/cordis'
import { guardedPlugin } from './guard.ts'

/**
 * 等待该组、启动并落定一个受守卫的子纤程，并在重新抛出任何
 * 启动失败之前释放它，从而一次失败的运行永不滞留。一个有效的、未解析的 inject 可能仍处于待定。
 * @param group - 每个宿主半区都挂在之下的 `cordis-dynamic` 组纤程。
 * @param plugin - 沙箱返回的插件；在启动前用注册守卫包裹。
 * @param reportGuardFailure - 向所属 Agent 报告激活后的 Host 守卫拒绝。
 * @returns 已落定的子纤程（可能仍待定于未满足的 `inject`）。
 */
export async function startHostHalf(
  group: Fiber,
  plugin: Plugin,
  reportGuardFailure: (error: Error) => void,
): Promise<Fiber> {
  await group.await()
  const fiber = group.ctx.plugin(guardedPlugin(plugin, reportGuardFailure))
  try {
    await fiber.await()
  } catch (error) {
    await fiber.dispose()
    const message = error instanceof Error ? error.message : String(error)
    // 最常见的启动冲突，是在旧的运行仍持有该名称时运行一个包的
    // 新版本——借此教给替换的做法。
    if (message.includes('already registered')) {
      throw new Error(
        `${message} — to REPLACE something an earlier dynamic package registered, first stop that package through its runner or the Cordis panel `
        + 'before running the new version.',
      )
    }
    throw error instanceof Error ? error : new Error(message)
  }
  return fiber
}

/**
 * 一个纤程在 `inject` 中声明、但尚不存在的服务——一个已落定
 * 却未活跃的纤程正在恰好等待这些（合法的 cordis 语义：
 * 当服务出现时它才激活）。
 * @param ctx - 据以解析服务是否存在的上下文。
 * @param fiber - 其 `inject` 声明被检查的宿主半区纤程。
 * @returns 缺失的服务名，按声明顺序。
 */
export function missingServices(ctx: Context, fiber: Fiber): string[] {
  return Object.keys(fiber.inject).filter(service => ctx.get(service) === undefined)
}
