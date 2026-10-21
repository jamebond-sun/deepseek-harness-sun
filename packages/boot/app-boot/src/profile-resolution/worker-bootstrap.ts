/** 在一个 Harness 拥有的 Worker 中安装继承来的运行时解析。 */

import { getEnvironmentData } from 'node:worker_threads'
import { installRuntimeInterception } from './resolver.ts'
import type { RuntimeResolution } from '../profile.ts'

const registration = getEnvironmentData(
  '@deepseek-ai/dsh-app-boot/profile-resolution',
) as {
  resolution: RuntimeResolution
} | undefined
if (registration !== undefined) installRuntimeInterception(registration.resolution)
