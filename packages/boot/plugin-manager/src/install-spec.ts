/**
 * 在 pnpm 看到安装 spec 之前读取它：它属于 pnpm 的哪种 spec 形式，以及对于注册表
 * 名称而言，它是否是一个注册表能够接受的名称。
 * @module @deepseek-ai/dsh-plugin-manager/install-spec
 */

import { homedir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'

/**
 * 一个被读入其形式、以及一次检视所需组成部分的 spec。git spec 与 tarball URL 都带有
 * pnpm 从其拉取的 `host`，没有任何注册表可以替代它；只有它们的依赖来自注册表。
 */
export type ParsedInstallSpec =
  | { readonly kind: 'registry'; readonly spec: string; readonly name: string; readonly range?: string }
  | { readonly kind: 'path'; readonly spec: string; readonly path: string }
  | { readonly kind: 'tarball'; readonly spec: string; readonly path?: string; readonly host?: string }
  | { readonly kind: 'git'; readonly spec: string; readonly host: string }

/** pnpm 通过 git 主机解析的形式：主机简写、git URL，或托管仓库 URL。 */
const GIT_SHORTHAND = /^(?:github|gitlab|bitbucket|gist):/i
const GIT_URL = /^git(?:\+[a-z]+)?:\/\/|^git@[^:]+:/i
const HOSTED_REPOSITORY_URL = /^https?:\/\/[^/]+\/[^/]+\/[^/#]+(?:\.git)?(?:#.*)?$/i
/** pnpm 简写所代表的主机。 */
const GIT_SHORTHAND_HOSTS: Readonly<Record<string, string>> = {
  github: 'github.com', gitlab: 'gitlab.com', bitbucket: 'bitbucket.org', gist: 'gist.github.com',
}
/** 一个 tarball，位于磁盘或 HTTP 之上。 */
const TARBALL_SPEC = /\.(?:tgz|tar\.gz)(?:#.*)?$/i
/** 一个 npm 包名：小写的 URL 安全段落、可选的 scope、不以点号或下划线开头。 */
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/
const PACKAGE_NAME_MAX_LENGTH = 214

/** pnpm 与注册表都不会接受的 spec；`reason` 是供使用者阅读的内容。 */
export class InvalidInstallSpecError extends Error {
  /**
   * @param spec - 按输入给出、已去除首尾空白的 spec。
   * @param reason - 它被拒绝的原因，一句话说明。
   */
  constructor(readonly spec: string, readonly reason: string) {
    super(`plugin-manager: ${reason}: ${spec}`)
    this.name = 'InvalidInstallSpecError'
  }
}

function invalid(spec: string, reason: string): InvalidInstallSpecError {
  return new InvalidInstallSpecError(spec, reason)
}

/** 一个 git spec 被克隆自的主机：简写的主机、类 scp 的 user@host，或带着端口的 URL 主机。 */
function gitHost(spec: string): string {
  const shorthand = /^([a-z]+):/i.exec(spec)?.[1]?.toLowerCase()
  if (shorthand !== undefined && Object.hasOwn(GIT_SHORTHAND_HOSTS, shorthand)) return GIT_SHORTHAND_HOSTS[shorthand] as string
  const scp = /^git@([^:]+):/i.exec(spec)?.[1]
  if (scp !== undefined) return scp.toLowerCase()
  return new URL(spec.replace(/^git\+/i, '')).host
}

/**
 * 读取一个 spec 并归为某种形式。路径必须是绝对路径：Host 的工作目录对浏览器中输入
 * 的人来说毫无意义，而相对于 profile 解析的相对路径会指向 profile 内部。
 * @param raw - 按输入给出的 spec。
 * @returns 解析后的 spec。
 * @throws 当 spec 为空、为相对路径、为注册表会拒绝的名称，或为既不是 git 主机也不是
 *   tarball 的 URL 时，抛出 {InvalidInstallSpecError}。
 */
export function parseInstallSpec(raw: string): ParsedInstallSpec {
  const spec = raw.trim()
  if (spec === '') throw invalid(spec, 'the package spec must not be empty')
  const path = spec.replace(/^(?:file|link):/, '')
  if (path !== spec || isAbsolute(path)) {
    if (!isAbsolute(path)) throw invalid(spec, 'a local path must be absolute')
    return TARBALL_SPEC.test(path) ? { kind: 'tarball', spec, path } : { kind: 'path', spec, path }
  }
  if (/^\.{1,2}(?:[\\/]|$)/.test(spec)) throw invalid(spec, 'a local path must be absolute')
  const git = GIT_SHORTHAND.test(spec) || GIT_URL.test(spec) || HOSTED_REPOSITORY_URL.test(spec)
  if (git && !TARBALL_SPEC.test(spec)) return { kind: 'git', spec, host: gitHost(spec) }
  if (/^https?:\/\//i.test(spec)) {
    if (TARBALL_SPEC.test(spec)) return { kind: 'tarball', spec, host: new URL(spec).host }
    throw invalid(spec, 'a URL must point at a git repository or a tarball')
  }
  const at = spec.indexOf('@', 1)
  const name = at === -1 ? spec : spec.slice(0, at)
  const range = at === -1 ? undefined : spec.slice(at + 1)
  if (name.length > PACKAGE_NAME_MAX_LENGTH || !PACKAGE_NAME.test(name)) {
    throw invalid(spec, 'not a package name the registry accepts')
  }
  if (range === '') throw invalid(spec, 'a version after @ must not be empty')
  return range === undefined ? { kind: 'registry', spec, name } : { kind: 'registry', spec, name, range }
}

/** profile 清单记录的、pnpm 在注册表之外解析的依赖值：除注册表别名外的协议，或类 scp 的 git 地址。 */
const NON_REGISTRY_VALUE = /^(?!(?:npm|jsr|workspace|catalog):)[a-z][a-z0-9+.-]*:|^[^@/:\s]+@[^:/\s]+:/i
/** 一个 http(s) URL 的用户信息，直到路径之前的最后一个 `@`；当存在时，它携带密码或访问令牌。 */
const HTTP_USER_INFO = /^((?:git\+)?https?:\/\/)[^/]*@/i

/**
 * profile 清单所记录的依赖对应的、`pnpm add` 能够接受的 spec。git 地址、URL，或其它
 * 非注册表协议是去掉了 http(s) URL 用户信息的记录值（其查询字符串被保留）；`file:` 或
 * `link:` 路径——pnpm 相对于 profile 记录它、或用 `~` 表示主目录——会被转为绝对路径。
 * 注册表的范围、标签或别名跟在 `@` 之后的依赖名后面，以一个非注册表值安装于包自身
 * 之外的名称之下时也是如此。
 * @param name - 依赖名称。
 * @param recorded - profile 清单为它记录的值。
 * @param profileDir - 相对本地路径所相对解析的 profile 目录。
 * @param packageName - 已安装包的清单所声明的名称，在能够被读取时给出。
 * @returns 可安装的 spec。
 */
export function dependencySpec(name: string, recorded: string, profileDir: string, packageName = name): string {
  const local = /^(file|link):(.*)$/s.exec(recorded)
  let spec: string
  if (local !== null) {
    const path = (local[2] as string).replace(/^~(?=$|[\\/])/, () => homedir())
    spec = `${local[1]}:${resolve(profileDir, path)}`
  } else if (NON_REGISTRY_VALUE.test(recorded)) {
    spec = recorded.replace(HTTP_USER_INFO, '$1')
  } else {
    return `${name}@${recorded}`
  }
  return packageName === name ? spec : `${name}@${spec}`
}
