/**
 * 目录选择接缝的自适应选择器：在启动时一次性判定宿主处境（远程来源信任、绑定地址、
 * SSH 启动、显示会话、选择器可执行文件），并将匹配的交互形态——`native` 或 `browse`——
 * 作为真正的 Loader 条目挂载到内存中的根树上。每种交互形态都是成对出现的：提供接缝
 * 能力的宿主后端，以及占据 ui-workspace 目录流程占位的应用界面。两者都以普通条目的
 * 形式加入，因此该界面的发现方式与配置行条目完全一致，且一次判定结果会同时替换这两
 * 个面；若要固定某种交互形态，直接组合这一对条目即可，无需使用本行。
 * @module @deepseek-ai/dsh-host-directory-picker-auto
 */

import type { Context } from '@deepseek-ai/cordis'
// 空类型导入用于携带下列读取所需的 `connection`、`loader`、`webServer` Context 合并声明。
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { launchedThroughSsh, launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { canExecute, hasLinuxChooserBinary } from './probe.ts'
import type { DirectoryPickerBackendKind } from './resolve.ts'
import { resolveDirectoryPickerBackend } from './resolve.ts'

export { canExecute, hasLinuxChooserBinary } from './probe.ts'
export type { DirectoryPickerBackendKind, DirectoryPickerEnv, DirectoryPickerHostFacts } from './resolve.ts'
export { resolveDirectoryPickerBackend } from './resolve.ts'

/** Cordis 插件名。 */
export const name = 'directory-picker-auto'
/**
 * 必需服务：HTTP 部署设置（`webServer`）、Connection 信任策略（`connection`），以及
 * 后端要挂载进去的条目树（`loader`）。
 */
export const inject = ['webServer', 'connection', 'loader']

/**
 * 每种判定结果对应的宿主后端包——这是固定的组合词汇表，不是可调参数。之所以导出，是
 * 因为该引用是静态配置门禁在 yml 行内看不到的运行时字符串：`verify-cordis-config`
 * 要求每个组合本选择器的应用都把这两个值声明为依赖。
 */
export const BACKEND_PACKAGES: Record<DirectoryPickerBackendKind, string> = {
  native: '@deepseek-ai/dsh-host-directory-picker-native',
  browse: '@deepseek-ai/dsh-host-directory-picker-browse',
}

/**
 * 每种判定结果对应的应用界面包，与后端一同挂载，从而一次判定仍能同时组合两个面。出于
 * 与 {@link BACKEND_PACKAGES} 相同的原因，每个组合它的应用都要将其声明为依赖。此处只
 * 引用说明符，因为这些包属于 Client 程序，本侧不存在对它们的导入。
 */
export const SURFACE_PACKAGES: Record<DirectoryPickerBackendKind, string> = {
  native: '@deepseek-ai/dsh-client-ui-directory-picker-native',
  browse: '@deepseek-ai/dsh-client-ui-directory-picker-browse',
}

/**
 * 依据启动时的采样判定交互形态，并把其后端与界面作为 Loader 条目挂载；该 effect 的
 * disposer 会移除两个条目并等待各自 fiber 的拆卸，因此卸载本插件时，会等到已挂载交互
 * 形态的两个面（及其依赖方）都 quiesce 之后才返回。
 * @param ctx - 携带被注入服务的 cordis context。
 */
export async function apply(ctx: Context): Promise<void> {
  const backend = resolveDirectoryPickerBackend({
    bindHost: ctx.webServer.host,
    allowsRemoteAuthorities: ctx.connection.allowsRemoteAuthorities,
    platform: process.platform,
    ssh: launchedThroughSsh(launchEnvironmentOf(ctx)),
    env: process.env,
    linuxChooser: hasLinuxChooserBinary(process.env.PATH, canExecute),
  })
  await ctx.effect(async () => {
    // 在根树上创建：Loader 的根是内存中的（write() 为空操作），因此挂载的行永远不会被
    // 回写进配置文件。后端先落地：界面的浏览器半边驱动的是后端所注册的能力。
    const ids: string[] = []
    const unmount = async () => {
      for (const id of [...ids].reverse()) {
        // 树的拆卸（group.stop）可能已经移除了该条目；此时既无需卸载也无需等待。
        const entry = ctx.loader.store[id]
        if (entry === undefined) continue
        const disposal = entry.fiber?.dispose()
        ctx.loader.remove(id)
        await disposal
      }
    }
    try {
      for (const name of [BACKEND_PACKAGES[backend], SURFACE_PACKAGES[backend]]) {
        const id = await ctx.loader.create({ name })
        ids.push(id)
        const entry = ctx.loader.resolve(id)
        if (entry.fiber === undefined) throw new Error(`directory-picker-auto: failed to load ${name}`)
        await entry.fiber.await()
      }
    } catch (cause) {
      // 在返回 disposer 之前，setup 阶段自己负责它创建的条目：若让后端继续挂载，重试时
      // 会与其自身的 directoryPicker 注册冲突。
      await unmount()
      throw cause
    }
    return unmount
  }, 'directory-picker-auto: interaction entries')
}
