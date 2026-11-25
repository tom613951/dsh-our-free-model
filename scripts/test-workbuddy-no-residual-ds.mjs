import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import ts from 'typescript'
import { registerHooks } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-wb-no-residual-'))
process.env.DSH_CODEARTS_CACHE_DIR = scratch
process.env.DSH_CHANNEL_PACK_STATE_DIR = scratch
process.env.DSH_HOME = scratch
process.env.DSH_OPENAI_GATEWAY_ENABLED = '0'

const kernel = pathToFileURL(path.join(repoRoot, 'scripts/lib/channel-pack-kernel.mjs')).href
const llmKernel = `data:text/javascript,${encodeURIComponent(`
export * from ${JSON.stringify(kernel)}
export class LlmError extends Error {
  constructor(message, code, options) { super(message, options); this.code = code; this.status = options?.status }
}
let nextMessage = 0
export function createUserMessage(value) { return { id: 'fixture-message-' + ++nextMessage, ...value } }
`)}`

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@deepseek-ai/dsh-llm') return { url: llmKernel, shortCircuit: true }
    if (specifier.startsWith('@deepseek-ai/')) return { url: kernel, shortCircuit: true }
    if (context.parentURL?.includes('/vendor/channel-pack/src/') && specifier.endsWith('.js')) {
      const tsCandidate = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL)
      if (fs.existsSync(new URL(tsCandidate))) return { url: tsCandidate.href, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url.endsWith('.ts') && url.includes('/vendor/channel-pack/src/')) {
      const source = fs.readFileSync(new URL(url), 'utf8')
      const out = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023 },
        fileName: url,
      })
      return { format: 'module', source: out.outputText, shortCircuit: true }
    }
    return nextLoad(url, context)
  },
})

const dispose = []

try {
  // 1. Source contract: WORKBUDDY excludes stale un-suffixed deepseek-v4.1-flash; CODEBUDDY preserves it
  const { WORKBUDDY, CODEBUDDY } = await import(pathToFileURL(path.join(repoRoot, 'vendor/channel-pack/src/product.ts')).href)
  const { BuddyAdapter } = await import(pathToFileURL(path.join(repoRoot, 'vendor/channel-pack/src/buddy-adapter.ts')).href)

  const wbFallbackIds = (WORKBUDDY.fallbackModels ?? []).map((m) => m.id)
  assert.equal(wbFallbackIds.includes('deepseek-v4.1-flash'), false, 'WORKBUDDY fallback must not keep stale deepseek-v4.1-flash')
  assert.equal(wbFallbackIds.includes('deepseek-v4.1-flash-sg'), true, 'WORKBUDDY fallback must keep deepseek-v4.1-flash-sg')

  const cbFallbackIds = (CODEBUDDY.fallbackModels ?? []).map((m) => m.id)
  assert.equal(cbFallbackIds.includes('deepseek-v4.1-flash'), true, 'CODEBUDDY fallback must preserve deepseek-v4.1-flash')

  const wbAdapter = new BuddyAdapter({
    credentialRef: 'WORKBUDDY_ACCESS_TOKEN',
    resolveCredential: async () => undefined,
    refresh: async () => {},
    fetchRemoteModels: async () => [
      {
        id: 'deepseek-v4.1-flash-sg',
        name: 'Deepseek-V4.1-Flash',
        creditsRate: 'x0.11',
        contextWindow: 1_000_000,
        maxOutputTokens: 128_000,
        supportsImages: true,
        reasoningEfforts: ['low', 'high', 'max'],
        defaultReasoningEffort: 'high',
        agentReferenced: true,
      },
    ],
    product: WORKBUDDY,
  })

  // Before remote fetch (static fallback)
  const staticDs = wbAdapter.listAllModels().filter((m) => m.id.includes('deepseek-v4.1'))
  assert.deepEqual(staticDs, [{ id: 'deepseek-v4.1-flash-sg', name: 'Deepseek-V4.1-Flash' }])

  // After remote fetch (reconciled with live /v3/config shape)
  const resolvedSg = await wbAdapter.resolveModel('workbuddy', 'deepseek-v4.1-flash-sg')
  assert.equal(resolvedSg.context?.contextWindow, 1_000_000)
  assert.deepEqual(resolvedSg.reasoning?.efforts.map((e) => e.id), ['low', 'high', 'max'])

  const remoteDs = wbAdapter.listAllModels().filter((m) => m.id.includes('deepseek-v4.1'))
  assert.deepEqual(remoteDs, [{ id: 'deepseek-v4.1-flash-sg', name: 'Deepseek-V4.1-Flash · x0.11' }])
  console.log('✓ 场景 1 通过：源码层 WORKBUDDY 已移除历史残留 deepseek-v4.1-flash，且 CODEBUDDY 与 -sg 展示正常')

  // 2. Bundled pack.js end-to-end check
  const adapters = new Map()
  const services = {
    profileContext: { home: scratch },
    credentials: {
      resolve: async () => undefined,
      describe: async () => undefined,
      set: async () => {},
      unset: async () => {},
    },
    llm: {
      registerAdapter(providers, adapter) {
        for (const provider of providers) adapters.set(provider, adapter)
      },
      listProviders: () => [...adapters.keys()].map((id) => ({ id })),
    },
    connection: { fetch: { register() {} } },
  }
  const ctx = {
    ...services,
    logger: { info() {}, warn() {}, error() {} },
    get: (name) => services[name],
    provide(name, service) { services[name] = service; this[name] = service },
    effect(cb) { const cleanup = cb(); if (typeof cleanup === 'function') dispose.push(cleanup) },
    inject(names, cb) { if (names.every((n) => services[n] !== undefined)) cb(this) },
    emit() {},
  }

  const pack = await import(pathToFileURL(path.join(repoRoot, 'vendor/channel-pack/pack.js')).href)
  pack.apply(ctx, { disableOpencode: true })
  await new Promise((resolve) => setImmediate(resolve))

  const wbPack = adapters.get('workbuddy')
  const cbPack = adapters.get('buddy')
  assert.ok(wbPack && cbPack, 'both workbuddy and buddy adapters must register in pack.js')

  const wbPackIds = wbPack.listAllModels().map((m) => m.id)
  assert.equal(wbPackIds.includes('deepseek-v4.1-flash'), false, 'pack.js workbuddy must not list stale deepseek-v4.1-flash')
  assert.equal(wbPackIds.includes('deepseek-v4.1-flash-sg'), true, 'pack.js workbuddy must list deepseek-v4.1-flash-sg')

  const cbPackIds = cbPack.listAllModels().map((m) => m.id)
  assert.equal(cbPackIds.includes('deepseek-v4.1-flash'), true, 'pack.js buddy must keep deepseek-v4.1-flash')
  console.log('✓ 场景 2 通过：pack.js 已同步移除 workbuddy 残留 deepseek-v4.1-flash 并保留 buddy')

  console.log('ALL WORKBUDDY RESIDUAL CLEANUP CHECKS PASSED!')
} finally {
  for (const cleanup of dispose.reverse()) await cleanup()
  hooks.deregister()
  fs.rmSync(scratch, { recursive: true, force: true })
}
