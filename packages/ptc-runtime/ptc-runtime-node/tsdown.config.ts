import { defineConfig } from 'tsdown'

/** Node provider 及其私有进程 bootstrap 都是要发布的 bundle。 */
export default defineConfig([
  { entry: ['lib/types/index.js'], outDir: 'lib', format: ['esm'], platform: 'node', target: 'es2024', fixedExtension: false, dts: false, clean: false },
  { entry: { process: 'lib/types/process-entry.js' }, outDir: 'lib', format: ['esm'], platform: 'node', target: 'es2024', fixedExtension: false, dts: false, clean: false, noExternal: ['@deepseek-ai/dsh-subprocess/control'] },
  { entry: { 'persistent-process': 'lib/types/persistent-process-entry.js' }, outDir: 'lib', format: ['esm'], platform: 'node', target: 'es2024', fixedExtension: false, dts: false, clean: false, noExternal: ['@deepseek-ai/dsh-subprocess/control'] },
])
