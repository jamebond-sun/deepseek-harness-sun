/** 对 Cordis 模块根之外的活动 profile 补丁文件进行精确路径监听。 */
import { dirname, relative, resolve, sep } from 'node:path'
import { realpath, stat } from 'node:fs/promises'
import { watch, type ChokidarOptions } from 'chokidar'
import type { Context } from '@deepseek-ai/cordis'

const registrations = new WeakMap<Context, Set<string>>()

async function findWatchRoot(filename: string): Promise<{ filename: string; root: string; depth: number }> {
  let root = dirname(filename)
  let depth = 0
  while (true) {
    try {
      if (!(await stat(root)).isDirectory()) throw new Error(`config watch parent is not a directory: ${root}`)
      const canonicalRoot = await realpath(root)
      return { filename: resolve(canonicalRoot, relative(root, filename)), root: canonicalRoot, depth }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = dirname(root)
      if (parent === root) throw error
      root = parent
      depth += 1
    }
  }
}

/**
 * 监听一个补丁路径及其父目录链，而不订阅兄弟文件或目录。
 * 缺失的父目录在出现时被观测；刷新回调串行运行。
 * @param ctx 拥有监听器释放职责并接收刷新失败的上下文。
 * @param filename 补丁文件的绝对路径。
 * @param options 部署监听器选项；配置监听默认启用写入稳定化。
 * @param refresh 用于新增、变更与移除的回调。
 * @param inTransaction 释放是否在正在被移除的刷新内部运行。
 * @returns 一个释放器，关闭监听器并排空其当前正在进行的刷新。
 * @throws 当路径解析、监听器启动或 effect 注册失败时。
 */
export async function watchConfig(
  ctx: Context, filename: string, options: ChokidarOptions, refresh: () => Promise<void> | void,
  inTransaction: () => boolean = () => false,
): Promise<() => Promise<void>> {
  const target = await findWatchRoot(filename)
  const paths = registrations.get(ctx) ?? new Set<string>()
  registrations.set(ctx, paths)
  if (paths.has(target.filename)) throw new Error(`config path already registered: ${filename}`)
  const { cwd: _cwd, ignored: _ignored, ...watchOptions } = options
  const watcher = watch(target.root, {
    // 稳定化事件绕过 Chokidar 有损的 50 ms 变更事件节流。
    awaitWriteFinish: true, ...watchOptions, depth: target.depth, ignoreInitial: false,
    ignored: (path) => {
      const remainder = relative(resolve(path), target.filename)
      return remainder === '..' || remainder.startsWith(`..${sep}`)
    },
  })
  paths.add(target.filename)
  const state = { dirty: false }
  let running: Promise<void> | undefined
  const onChange = (path: string) => {
    const observed = resolve(path)
    if (observed !== filename && observed !== target.filename) return
    state.dirty = true
    if (running) return
    running = (async () => {
      while (state.dirty) {
        state.dirty = false
        try {
          await refresh()
        } catch (reason) {
          const error = reason instanceof Error ? reason : new Error(String(reason), { cause: reason })
          ctx.logger.warn('config reload at %C failed', filename)
          ctx.logger.warn(error)
        }
      }
    })().finally(() => { running = undefined })
  }
  watcher.on('add', onChange)
  watcher.on('change', onChange)
  watcher.on('unlink', onChange)
  const ready = Promise.withResolvers<void>()
  let pending = true
  let disposed = false
  watcher.once('ready', () => { pending = false; ready.resolve() })
  const onError = (error: unknown): void => {
    // 释放之后的监听器错误无法处理：该注册的
    // 路径已消失，不会运行任何刷新。
    if (disposed) return
    if (pending) { pending = false; ready.reject(error) } else { ctx.logger.warn(error) }
  }
  watcher.on('error', onError)
  const dispose = async () => {
    disposed = true
    // `close()` 会移除所有监听器，但留下一个已排期的写入沉降轮询；
    // 其滞后的轮询会对本次清理正在删除的文件执行 stat，Windows
    // 将其报告为 EPERM，而没有监听器的 'error' 发射会被重新抛出为
    // 未捕获异常。在关闭期间重新挂载。
    const closing = watcher.close()
    watcher.on('error', onError)
    await closing
    paths.delete(target.filename)
    if (!inTransaction()) await running
  }
  try {
    await ready.promise
    return ctx.effect(() => dispose, 'hmr.watchConfig()')
  } catch (error) {
    await dispose()
    throw error
  }
}
