import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { workers, log, spawn } = vi.hoisted(() => ({
  workers: [] as FakeWorker[],
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  spawn: { failNext: false },
}))

class FakeWorker extends EventEmitter {
  posted: unknown[] = []
  terminated = false
  constructor() {
    super()
    if (spawn.failNext) {
      spawn.failNext = false
      throw new Error('cannot spawn')
    }
    workers.push(this)
  }
  postMessage(message: unknown) {
    this.posted.push(message)
  }
  /** Simulates the worker answering the last compose request. */
  reply(sdl = 'type Query { ok: Boolean }') {
    this.emit('message', { sdl })
  }
  terminate() {
    this.terminated = true
    this.emit('exit', 1)
    return Promise.resolve(1)
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
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    })
    workers.length = 0
    spawn.failNext = false
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

  it('spawns a replacement after the worker exits and recomposes with it at once', async () => {
    const mod = await boot()
    expect(workers).toHaveLength(1)

    workers[0]!.emit('exit', 1)
    await vi.advanceTimersByTimeAsync(1_000)

    expect(workers).toHaveLength(2)
    expect(workers[1]!.posted).toEqual([{ type: 'compose' }])
    workers[1]!.reply('type Query { fresh: Boolean }')
    await flush()
    expect(mod.getSupergraph()).toContain('fresh')
    expect(mod.isSupergraphReady()).toBe(true)
  })

  it('schedules another attempt when spawning the replacement throws', async () => {
    const mod = await boot()

    spawn.failNext = true
    workers[0]!.emit('exit', 1)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(workers).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(5_000)
    expect(workers).toHaveLength(2)
    expect(workers[1]!.posted).toEqual([{ type: 'compose' }])
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
    expect(mod.hasCompositionGivenUp()).toBe(true)
    expect(log.error).toHaveBeenCalledWith(expect.stringMatching(/giving up/i), expect.anything())
  })

  it('resets the backoff once a replacement has composed and stayed up for a while', async () => {
    const mod = await boot()

    for (const delay of [1_000, 5_000, 30_000]) {
      workers.at(-1)!.emit('exit', 1)
      await vi.advanceTimersByTimeAsync(delay)
    }
    workers.at(-1)!.reply()
    await flush()
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    const pending = mod.composeSupergraph()
    await flush()
    workers.at(-1)!.reply()
    await pending

    workers.at(-1)!.emit('exit', 1)
    await vi.advanceTimersByTimeAsync(1_000)

    expect(workers).toHaveLength(5)
    expect(mod.isSupergraphReady()).toBe(true)
  })

  it('keeps escalating the backoff when a replacement crashes right after composing', async () => {
    await boot()

    workers[0]!.emit('exit', 1)
    await vi.advanceTimersByTimeAsync(1_000)
    workers[1]!.reply()
    await flush()

    workers[1]!.emit('exit', 1)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(workers).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(4_000)
    expect(workers).toHaveLength(3)
  })

  it('rejects the pending compose when the worker exits mid-compose, then recomposes on the replacement', async () => {
    const mod = await boot()
    const pending = mod.composeSupergraph()
    await flush()

    workers[0]!.emit('exit', 1)

    await expect(pending).rejects.toThrow(/exited/)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(workers).toHaveLength(2)
    expect(workers[1]!.posted).toEqual([{ type: 'compose' }])
  })

  it('terminates a worker that never answers a compose and replaces it', async () => {
    const mod = await boot()
    const pending = mod.composeSupergraph().catch((error: unknown) => error)
    await flush()

    await vi.advanceTimersByTimeAsync(3 * 60_000)

    expect(workers[0]!.terminated).toBe(true)
    expect(await pending).toMatchObject({ message: expect.stringMatching(/timed out|exited/) })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(workers).toHaveLength(2)
    expect(mod.isSupergraphReady()).toBe(true)
  })

  it('rejects a compose reply that carries no sdl string and keeps the previous schema', async () => {
    const mod = await boot()
    const before = mod.getSupergraph()
    const pending = mod.composeSupergraph()
    await flush()

    workers[0]!.emit('message', {})

    await expect(pending).rejects.toThrow(/sdl/)
    expect(mod.getSupergraph()).toBe(before)
    expect(mod.isSupergraphReady()).toBe(true)
  })
})
