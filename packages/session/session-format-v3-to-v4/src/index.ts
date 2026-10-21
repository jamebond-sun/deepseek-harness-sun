/** 具备原生 V4 分帧与投递校验的 tool-role V3→V4 迁移。 */

export { releasedV3SessionFormatCodec } from '@deepseek-ai/dsh-session-format-v2-to-v3'
export * from './codec.ts'
export * from './migration.ts'
export { assertReleasedV4Header, assertReleasedV4Relationships, restoreReleasedV4Artifact } from './validation.ts'
export { historicalChildCatalogSource } from './facts.ts'
export { RELEASED_V3_EVENT_TYPES } from './extension-identities.ts'
