/** 解析一个已抓取索引响应体、并将结果回传给其父线程的 Worker 线程入口。 */
import { parentPort, workerData } from 'node:worker_threads'
import { parseIndexBody, type IndexParseRequest } from './parse.ts'

const request = workerData as Partial<IndexParseRequest> | null
if (!(request?.body instanceof Uint8Array) || typeof request.url !== 'string') throw new Error('index parser request is malformed')
parentPort?.postMessage(parseIndexBody(request.body, request.url))
