/**
 * 本包服务的各配置界面的浏览器安全失败词汇表。脱敏视图本身与其接缝
 * 一同位于 `@deepseek-ai/dsh-settings/types`，其 Cordis 事件声明已经为
 * Client 编译面注册了该文件。
 *
 * @module @deepseek-ai/dsh-api-settings-controller/types
 */

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /**
     * 过期写入之外的每种接缝拒绝：未注册或畸形的命名空间、只读提供方、
     * schema 校验、存储。
     */
    'settings/rejected': { readonly ns: string }
    /**
     * 已存储的修订号在调用方读取之后发生了移动。这是独立的结果而非
     * 无效请求：调用方必须重新读取并重新应用。
     */
    'settings/conflict': { readonly ns: string; readonly expected: number; readonly actual: number }
    /**
     * 提供方拒绝了一次有效的凭据写入，例如因为已存储的文档不再能解析。
     * details 只给出引用，绝不包含值。
     */
    'credential/rejected': { readonly ref: string }
  }
}

/** 设置文档已交给原生编辑器的确认。 */
export interface SettingsDocumentOpenValue {
  readonly opened: true
}
