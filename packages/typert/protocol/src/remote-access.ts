/**
 * Remote 访问控制的资源：内置的无身份 `global` 资源，以及 `TypertResourceMap`
 * 中声明的每种身份各一个资源。资源相互独立：访问某一资源并不意味着
 * 拥有对其他任何资源的访问权。
 * @module @deepseek-ai/dsh-typert-protocol/remote-access
 */

/* oxlint-disable typescript/no-redundant-type-constituents --
 * `TypertResourceKind` is the declare-merge key pattern: the resource map is
 * empty in this compilation unit, so the rule sees `never`, while every
 * domain that declares a kind merges its key in. */
import type {
  TypertResourceId,
  TypertResourceKind,
  TypertResourceMap,
} from './types.ts'

/** 一种资源种类：内置的 `global` 种类或某个已声明的种类。 */
export type RemoteAccessResourceKind = 'global' | TypertResourceKind

/**
 * 一次调用或转发事件触及的一种资源：`global`，或某个已声明种类的一个身份。
 * 身份是传输线值，在任何 lookup 解析或校验之前读取。
 */
export type RemoteAccessResource =
  | { readonly kind: 'global' }
  | {
    [Kind in TypertResourceKind]: { readonly kind: Kind; readonly id: TypertResourceId<TypertResourceMap[Kind]> }
  }[TypertResourceKind]

/**
 * 某一资源种类对应的资源变体：对于 `global` 为 `{ kind: 'global' }`，否则
 * 为该种类及其身份。
 * @template K - 要选择的资源种类。
 */
export type RemoteAccessResourceOf<K extends RemoteAccessResourceKind> = Extract<RemoteAccessResource, { readonly kind: K }>
