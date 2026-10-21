/**
 * Typert 分析器、与编译器无关的模型，以及模型驱动的产物发射器的公共 API。
 * 构建装配位于 `./tsdown` 子路径。
 * @module @deepseek-ai/dsh-typert-generator
 */

export { WorkspaceAnalyzer, WorkspaceCaches, TypertAnalysisError } from './analyzer.ts'
export type { AnalysisMode, DiscoveredTypertPackage, WorkspaceAnalyzerOptions } from './analyzer.ts'
export { FaceModelEmitter, TypertEmitError } from './emitter.ts'
export type { ModelEmitResult } from './emitter.ts'
export * from './cordis-catalog.ts'
export { TypeGraphRenderer, TypeGraphRenderError } from './renderer.ts'
export { findWorkspaceRoot, WorkspaceTypertGenerator } from './workspace.ts'
export type { WorkspaceEmitResult, WorkspaceTypertGeneratorOptions } from './workspace.ts'
export { writePackageArtifacts, writeWorkspaceArtifacts } from './artifact-files.ts'
export type * from './model.ts'
