/** 启动器拥有的 profile 位置与组合输入。 */
import { join } from 'node:path'
import { composeEntries, loadProfileDirectory, PROFILE_PATCH_FILENAME, type Profile } from './profile.ts'
import { loadOptionalPatches } from './index.ts'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'

/** 应用所拥有的包管理器可执行文件；环境仅应用于包操作。 */
export interface ProfilePnpmInvocation {
  readonly command: string
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
}

/** 当前 profile 的事实；调度与变更属于各自的调用方。 */
export interface ProfileContext {
  readonly name: string
  /** 打包应用提供其自带的运行时，而非一个 PATH 可执行文件。 */
  readonly packageManager?: ProfilePnpmInvocation
  readonly dir: string
  readonly patchPath: string
  readonly installAnchor: string
  readonly cwd: string
  readonly home: string
  /** 在任何持久化编辑之前，用于启动本进程的 bundle 包。 */
  readonly startedBundles: readonly string[]
  /** 已解析的命令行覆盖层，应用于 profile 与 home 补丁之上。 */
  readonly overlays: readonly PatchOptions[]
  /** 启动时的 DSH_TELEMETRY_DISABLED 值；任何非空值都表示退出。 */
  readonly telemetryDisabledEnv: string | undefined
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 仅出现在由 dsh 启动的 profile 中。 */
    profileContext: ProfileContext
  }
}

const TELEMETRY_ROW_ID = 'session-telemetry-otel'

/**
 * 将遥测退出开关解析为其启动补丁。任意非空值（包括 `'0'`/`'false'`）都会禁用：隐私开关
 * 宁可“误关”也不要“误开”。一个不含遥测行的组合不导出任何内容，因此该开关便被平凡地
 * 满足，也不会生成补丁——自定义 profile 无需挂载遥测即可在该开关被设置的情况下运行。
 * @param disabledEnv - 原始的 `DSH_TELEMETRY_DISABLED` 值（未设置时为 `undefined`）。
 * @param hasRow - 组合是否携带遥测行。
 * @returns 禁用补丁；当不需要硬性禁用补丁时，为 `undefined`。
 */
export function resolveTelemetryPatch(disabledEnv: string | undefined, hasRow: boolean): PatchOptions | undefined {
  if ((disabledEnv ?? '') === '' || !hasRow) return undefined
  return { id: TELEMETRY_ROW_ID, disabled: true }
}

/** 读取所选 bundle 的补丁，它们应用于 profile 补丁文件之前。
 * @param binName 针对畸形或缺失配置的诊断前缀。
 * @param context 由 profile 启动器提供的数据。
 * @param initialProfile 已加载的启动 profile；省略时读取当前文件。
 * @returns 按应用顺序排列的 bundle 补丁。
 */
export function readBundlePatches(binName: string, context: ProfileContext, initialProfile?: Profile): PatchOptions[] {
  const profile = initialProfile ?? loadProfileDirectory(binName, context.dir, context.installAnchor, { userLayer: false })
  return profile.layers.flatMap(layer => layer.patches)
}

/** 读取当前的 bundle 与用户层，以及启动时的覆盖层。
 * @param binName 针对畸形或缺失配置的诊断前缀。
 * @param context 由 profile 启动器提供的数据。
 * @param initialProfile 已加载的启动 profile；省略时读取当前文件。
 * @returns 分离的有序补丁；本函数不会更新 Loader。
 */
export function readProfilePatches(binName: string, context: ProfileContext, initialProfile?: Profile): PatchOptions[] {
  const patches = structuredClone([
    ...readBundlePatches(binName, context, initialProfile),
    ...(initialProfile?.patches ?? loadOptionalPatches(binName, context.patchPath) ?? []),
    ...(loadOptionalPatches(binName, join(context.home, PROFILE_PATCH_FILENAME)) ?? []),
    ...context.overlays,
  ])
  const telemetryPatch = resolveTelemetryPatch(context.telemetryDisabledEnv,
    composeEntries([patches]).some(row => row.id === TELEMETRY_ROW_ID))
  if (telemetryPatch !== undefined) patches.push(telemetryPatch)
  return patches
}
