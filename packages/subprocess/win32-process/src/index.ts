/** 共享的低层 Win32 进程、stdio 与 Job Object 原语。 */

export { ERROR_INSUFFICIENT_BUFFER } from './abi.ts'
export * from './errors.ts'
export {
  allocPtrSlot,
  allocUint32,
  decodePtr,
  decodeUint32,
  extendWin32ProcessBindings,
  isNullPtr,
  loadWin32ProcessBindings,
  throwLastError,
  throwWin32,
} from './ffi.ts'
export type {
  CurrentTokenProcessBindings,
  NativePtr,
  Win32ProcessBindings,
} from './ffi.ts'
export {
  closeHandleChecked,
  drainPipe,
  isJobEmpty,
  pollProcessExit,
  probeCurrentTokenJobSupport,
  spawnInheritedJobProcess,
  spawnCurrentTokenJobProcess,
  spawnPipedProcess,
  terminateJob,
  waitForProcessExit,
} from './process.ts'
export type {
  CurrentTokenStdioFileDescriptors,
  CurrentTokenProcessSpawnOptions,
  SpawnedJobProcess,
  SpawnedPipedProcess,
} from './process.ts'
