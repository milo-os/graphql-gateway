import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { workers, log } = vi.hoisted(() => ({
  workers: [] as FakeWorker[],
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

class FakeWorker extends EventEmitter {
  posted: unknown[] = []
  constructor() {
    super()
    workers.push(this)
  }
  postMessage(message: unknown) {
    this.posted.push(message)
  }
  /** Simulates the worker answering the last compose request. */
  reply(sdl = 'type Query { ok: Boolean }') {
    this.emit('message', { sdl })
  }
}

vi.mock('node:worker_threads', () => ({ Worker: FakeWorker }))
vi.mock('@/gateway/auth', () => ({
  getMTLSConfig: () => ({ server: 'https://k8s.test', certPath: 'c', keyPath: 'k', caPath: 'ca' }),
}))
vi.mock('@/shared/utils', () => ({ log }))
vi.mock('@/gateway/config', () => ({ env: { pollingInterval: 60 * 60 * 1000, logLevel: 'info' } }))

const flush = () => new Promise((resolve) => setImmediate(resolve))

describe('composition worker supervision', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    workers.length = 0
    vi.resetModules()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  const boot = async () => {
    const mod = await import('./composition')
    const init = mod.initializeGateway()
    await flush()
    workers[0]!.reply()
    await init
    return mod
  }

  it('spawns a replacement after the worker exits and composes with it', async () => {
    const mod = await boot()
    expect(workers).toHaveLength(1)

    workers[0]!.emit('exit', 1)
    await vi.advanceTimersByTimeAsync(1_000)

    expect(workers).toHaveLength(2)
    const pending = mod.composeSupergraph()
    await flush()
    expect(workers[1]!.posted).toEqual([{ type: 'compose' }])
    workers[1]!.reply('type Query { fresh: Boolean }')
    await expect(pending).resolves.toContain('fresh')
    expect(mod.isSupergraphReady()).toBe(true)
  })

  it('rejects a compose while no worker is alive instead of posting into a dead one', async () => {
    const mod = await boot()
    const postedBefore = workers[0]!.posted.length

    workers[0]!.emit('exit', 1)

    await expect(mod.composeSupergraph()).rejects.toThrow(/no composition worker/i)
    expect(workers[0]!.posted).toHaveLength(postedBefore)
    expect(mod.isSupergraphReady()).toBe(true)
  })

  it('gives up after the backoff schedule and reports the gateway not ready', async () => {
    const mod = await boot()

    for (const delay of [1_000, 5_000, 30_000]) {
      workers.at(-1)!.emit('exit', 1)
      await vi.advanceTimersByTimeAsync(delay)
    }
    expect(workers).toHaveLength(4)

    workers.at(-1)!.emit('exit', 1)
    await vi.advanceTimersByTimeAsync(60_000)

    expect(workers).toHaveLength(4)
    expect(mod.isSupergraphReady()).toBe(false)
    expect(log.error).toHaveBeenCalledWith(expect.stringMatching(/giving up/i), expect.anything())
  })

  it('resets the backoff once a replacement composes successfully', async () => {
    const mod = await boot()

    for (const delay of [1_000, 5_000, 30_000]) {
      workers.at(-1)!.emit('exit', 1)
      await vi.advanceTimersByTimeAsync(delay)
    }
    const pending = mod.composeSupergraph()
    await flush()
    workers.at(-1)!.reply()
    await pending

    workers.at(-1)!.emit('exit', 1)
    await vi.advanceTimersByTimeAsync(1_000)

    expect(workers).toHaveLength(5)
    expect(mod.isSupergraphReady()).toBe(true)
  })
})
