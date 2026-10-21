/**
 * Todo 领域的客户端命名空间投影：对包的类型出口的纯再导出。
 * 客户端代码只导入客户端命名空间（仓库规范），因此 `./client`
 * 将 `./types` 服务于宿主消费者的同一单源内容投影到客户端 ——
 * 零重复。
 *
 * @module @deepseek-ai/dsh-tool-todo/client
 */

export type * from './types.ts'
