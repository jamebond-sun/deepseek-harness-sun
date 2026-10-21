/**
 * `ctx.directoryPicker` 能力接缝的服务定义：Web GUI 宿主如何供操作者选择工作区目录。
 * 各后端的差异在于交互形态，而非仅仅在于实现机制，因此本服务暴露的是一个可判别的能力
 * （capability），而非一组固定的方法：`native` 后端在宿主显示器上打开一个操作系统目录
 * 选择器；`browse` 后端则提供列目录/建目录原语，供应用内浏览器逐层驱动（因此也能服务
 * 于操作系统对话框触及不到的远程客户端）。消费方按 `capability().kind` 分支；该联合
 * 类型支持声明合并扩展，遇到未知 kind 时的既定默认行为是隐藏选择入口，而不是报错。
 * @module @deepseek-ai/dsh-host-directory-picker
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { DirectoryListing } from './types.ts'

export type { DirectoryEntry, DirectoryListing } from './types.ts'

/** 原生交互形态：在宿主显示器上打开一个操作系统目录选择器。 */
export interface DirectoryPickerNativeCapability {
  kind: 'native'
  /**
   * 打开选择器并等待操作者。
   * @param signal - 调用方/连接生命周期；终止信号会关闭选择器。
   * @returns 选中的绝对路径；操作者取消时为 null。
   */
  pick(signal: AbortSignal): Promise<string | null>
}

/**
 * 浏览交互形态：由应用内浏览器逐层驱动的列目录/建目录原语。对远程客户端同样可用——
 * 宿主显示器上不渲染任何内容。
 */
export interface DirectoryPickerBrowseCapability {
  kind: 'browse'
  /**
   * 列出一层目录。
   * @param path - 要列出的绝对目录；缺省时列出主目录。
   * @param signal - 调用方生命周期；终止信号会停止扫描（挂载的网络目录不得比已断开
   * 的调用方活得更久），并以终止原因拒绝。
   * @returns 该层目录的列表结果及祖先链；后端对完整结果设有上限，被截断的一层会置
   * `truncated`。
   * @throws {DirectoryPickerError} 当目标不是完全限定路径时抛出 `directory-unreadable`
   * （来自线上的值绝不能相对宿主的 cwd 解析，在 Windows 上也不能相对其当前驱动器解析），
   * 或当目标无法列出时抛出该错误。
   */
  list(path?: string, signal?: AbortSignal): Promise<DirectoryListing>
  /**
   * 在既有父目录下创建一个子目录。
   * @param path - 已存在的绝对父目录。
   * @param name - 单个非空白路径段（不含分隔符，也不是 `.`/`..`）。
   * @returns 新建目录的绝对路径。
   * @throws {DirectoryPickerError} 子目录已存在时抛出 `directory-exists`；父目录不是
   * 完全限定路径或发生其他失败时抛出 `directory-create-failed`。
   */
  createDirectory(path: string, name: string): Promise<string>
}

/**
 * 按能力 kind 索引的交互形态注册表，支持声明合并扩展：新后端在此声明合并自己的形态
 * （条目的 `kind` 字面量必须与其键相同），而不是修改本包。
 */
export interface DirectoryPickerCapabilities {
  native: DirectoryPickerNativeCapability
  browse: DirectoryPickerBrowseCapability
}

/** 后端可提供的交互形态联合类型，由支持声明合并的 {@link DirectoryPickerCapabilities} 映射派生。 */
export type DirectoryPickerCapability = DirectoryPickerCapabilities[keyof DirectoryPickerCapabilities]

/** 浏览原语的封闭失败码词汇表（由消费方原样映射到线上）。 */
export type DirectoryPickerErrorCode = 'directory-unreadable' | 'directory-exists' | 'directory-create-failed'

/** 浏览原语抛出的带类型失败，使消费方无需字符串匹配即可映射业务错误码。 */
export class DirectoryPickerError extends Error {
  /**
   * @param code - 该失败的封闭业务错误码。
   * @param path - 失败所涉及的绝对路径。
   * @param message - 面向操作者的描述。
   */
  constructor(readonly code: DirectoryPickerErrorCode, readonly path: string, message: string) {
    super(message)
    this.name = 'DirectoryPickerError'
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    directoryPicker: DirectoryPicker
  }
}

/**
 * 抽象的目录选择服务。请继承它、实现 `capability()`，并将子类作为插件加载——它会注册
 * 为 `ctx.directoryPicker`（同一 context 只允许一个实现；加载第二个会抛出错误，这是
 * cordis 标准的重复服务行为）。能力对象在服务生命周期内必须保持稳定：消费方可能会
 * 跨调用持有它。
 */
export abstract class DirectoryPicker extends Service {
  constructor(ctx: Context) {
    super(ctx, 'directoryPicker')
  }

  /**
   * 后端的交互能力。
   * @returns 供消费方分支判别的能力对象。
   */
  abstract capability(): DirectoryPickerCapability
}

export default DirectoryPicker
