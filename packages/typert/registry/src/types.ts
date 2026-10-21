/**
 * 纯粹的、生成产物与运行时注册表的类型。注册表将 Zod schema
 * 与生成的包反射元数据分开存储。
 * @module @deepseek-ai/dsh-typert-registry/types
 */

import type { z } from 'zod'
import type { InvocationDescriptor } from '@deepseek-ai/dsh-typert-protocol'

/** 产出某贡献、彼此独立编译的一端。 */
export type TypertFace = 'host' | 'client'

/** 由生成运行时元数据保留的结构化 JSDoc 标签。 */
export interface TypertDocTag {
  readonly name: string
  readonly argument?: string
  readonly comment?: string
  readonly text: string
}

/** 保留在被反射包元素上的源文档。 */
export interface TypertDocumentation {
  readonly description?: string
  readonly summary?: string
  readonly tags: readonly TypertDocTag[]
  readonly jsDoc?: string
}

/** 一份已生成的公共成员签名。 */
export interface TypertMemberModel {
  readonly kind: 'property' | 'method' | 'getter' | 'setter' | 'call' | 'construct' | 'index'
  readonly name: string
  readonly signature: string
  readonly summary?: string
  readonly jsDoc?: string
}

/** 一个被反射业务表面所引用的具名类型声明。 */
export interface TypertTypeModel {
  readonly name: string
  readonly declaration: string
}

/** 某个 Cordis service 的运行时反射元数据。 */
export interface TypertServiceModel extends TypertDocumentation {
  readonly key: string
  readonly exportName: string
  readonly members: readonly TypertMemberModel[]
  readonly types: readonly TypertTypeModel[]
}

/** 一个 Cordis 事件的运行时反射元数据。 */
export interface TypertEventModel extends TypertDocumentation {
  readonly name: string
  readonly mode?: string
  readonly signature: string
}

/** 一个显式导出的引用对象的运行时反射元数据。 */
export interface TypertObjectModel extends TypertDocumentation {
  readonly name: string
  readonly exportName: string
  readonly members: readonly TypertMemberModel[]
  readonly types: readonly TypertTypeModel[]
}

/** 一个包在一个端上生成的业务反射。 */
export interface TypertPackageModel {
  readonly services: readonly TypertServiceModel[]
  readonly events: readonly TypertEventModel[]
  readonly objects: readonly TypertObjectModel[]
}

/** 一个生成的 Zod schema 工厂。 */
export interface TypertSchemaFactory {
  readonly name: string
  /** 在首次使用时实例化并返回进程 realm 中的 schema。 */
  readonly create: () => z.ZodType
}

/** 一个生成的包贡献，原子地注册与撤回。 */
export interface TypertContribution {
  readonly package: string
  readonly face: TypertFace
  readonly schemas: readonly TypertSchemaFactory[]
  readonly model: TypertPackageModel
  /** Host 调用定义；当包未导出任何 Remote 方法时为空。 */
  readonly invocations: readonly InvocationDescriptor[]
}

/** 一个存活 schema 及其贡献身份。 */
export interface TypertSchemaRecord {
  readonly name: string
  readonly schema: z.ZodType
  readonly package: string
  readonly face: TypertFace
  readonly key: string
}

/** 一个存活的、生成的包模型及其稳定身份。 */
export interface TypertPackageRecord {
  readonly package: string
  readonly face: TypertFace
  readonly key: string
  readonly model: TypertPackageModel
}

/** schema 枚举的过滤器。 */
export interface TypertSchemaFilter {
  readonly package?: string
  readonly face?: TypertFace
}

/** 包模型枚举的过滤器。 */
export interface TypertPackageFilter {
  readonly package?: string
  readonly face?: TypertFace
}
