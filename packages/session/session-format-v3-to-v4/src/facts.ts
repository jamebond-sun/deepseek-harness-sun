/** 历史子会话身份，精简为父目录所需字段。 */

import { SessionFormatError, SessionFormatUnsupportedMigrationError, isSessionFormatJsonObject, sessionFormatCount } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatArtifact, SessionFormatJsonObject, SessionFormatJsonValue } from '@deepseek-ai/dsh-session-format'

/**
 * 收集子会话自身的描述符，且在读取其父目录之前不要求一定存在该描述符。
 * @param artifact - 已校验的历史子会话制品，带有其精确的继承切点。
 * @returns 紧凑的子会话身份与描述符证据，含用于补全目录的已校验发现字段。
 * @throws SessionFormatError 当某个受支持的自身描述符含有无效的发现字段时抛出。
 */
export function historicalChildCatalogSource(artifact: SessionFormatArtifact): SessionFormatJsonObject {
  const header = artifact.header
  if (header.origin !== 'subagent' || header.parentSession === undefined) {
    throw new SessionFormatUnsupportedMigrationError('catalog migration requires a subagent child with a direct parent')
  }
  const descriptors = artifact.events.filter(event => event.type === 'subagent/descriptor' && event.seq >= artifact.inheritedEventCount)
  const source = {
    childId: header.id, childCreatedAt: header.createdAt,
    descriptorCount: descriptors.length, descriptor: descriptors[0]?.data ?? null,
  }
  childCatalogFact(source)
  return source
}

/**
 * 校验通过迁移 JSON 接口提供的补充子会话证据。
 * @param value - 已收集的子会话身份与可选描述符。
 * @returns 已校验的证据；描述符的解释推迟到父成员身份已知之后。
 */
export function childCatalogSource(value: SessionFormatJsonValue): SessionFormatJsonObject {
  if (!isSessionFormatJsonObject(value) || typeof value['childId'] !== 'string'
    || !Object.hasOwn(value, 'descriptor')) {
    throw new SessionFormatUnsupportedMigrationError('catalog migration requires historical child identity and descriptor evidence')
  }
  sessionFormatCount(value['childCreatedAt'], 'catalog child creation time')
  sessionFormatCount(value['descriptorCount'], 'child descriptor count')
  return value
}

/**
 * 只解释已知历史描述符的发现字段。
 * @param source - 已校验的子会话证据。
 * @returns 一个目录事实；若没有恰好一个受支持的自身描述符则为 undefined。
 */
export function childCatalogFact(source: SessionFormatJsonObject): SessionFormatJsonObject | undefined {
  const id = source['childId'] as string
  const descriptor = source['descriptor']
  const count = source['descriptorCount'] as number
  const known = isSessionFormatJsonObject(descriptor) && [1, 2, 3].includes(descriptor['version'] as number)
  if (count !== 1 || !known) return undefined
  if (typeof descriptor['provider'] !== 'string') {
    throw new SessionFormatUnsupportedMigrationError(`${childCatalogSubject(source)} has an invalid subagent descriptor provider`)
  }
  if (descriptor['version'] !== 1 && descriptor['mode'] !== 'continuable' && descriptor['mode'] !== 'one-shot') {
    throw new SessionFormatUnsupportedMigrationError(`${childCatalogSubject(source)} has an invalid subagent descriptor mode`)
  }
  return catalogFact({
    version: 0, childId: id, childCreatedAt: source['childCreatedAt'] as number,
    // V1 只描述可续接的子会话，且没有 mode 字段。
    mode: descriptor['version'] === 1 ? 'continuable' : descriptor['mode'] as SessionFormatJsonValue,
    ...(descriptor['label'] === undefined ? {} : { label: descriptor['label'] }),
  }, childCatalogSubject(source))
}

/**
 * 校验用于目录成员身份的历史字段，不解释扩展内容。
 * @param value - 目录载荷，或已准备好的历史发现事实。
 * @param subject - 用于拒绝诊断的事件类型或子会话身份。
 * @returns 已校验的目录载荷。
 */
export function catalogFact(value: SessionFormatJsonValue, subject = 'subagent/catalog'): SessionFormatJsonObject {
  if (!isSessionFormatJsonObject(value) || (value['version'] !== 0 && value['version'] !== 1 && value['version'] !== 2)
    || typeof value['childId'] !== 'string'
    || (value['mode'] !== 'continuable' && value['mode'] !== 'one-shot' && value['mode'] !== 'external' && value['mode'] !== 'unknown')
    || ((value['version'] === 2) !== (value['mode'] === 'external'))
    || (value['version'] === 0 && value['mode'] === 'unknown')
    || (value['mode'] === 'continuable' && typeof value['label'] !== 'string')
    || (value['label'] !== undefined && typeof value['label'] !== 'string')) {
    throw new SessionFormatError(`${subject} requires a supported versioned catalog fact`)
  }
  sessionFormatCount(value['childCreatedAt'], 'catalog child creation time')
  return value
}

/**
 * 在迁移诊断中标明子会话及其可选的、由存储拥有的位置。
 * @param source - 已校验的补充子会话证据。
 * @returns 子会话身份，并在持久化提供源路径时附带该路径。
 */
export function childCatalogSubject(source: SessionFormatJsonObject): string {
  return `Session ${source['childId'] as string}${typeof source['sourcePath'] === 'string' ? ` (raw log: ${source['sourcePath']})` : ''}`
}
