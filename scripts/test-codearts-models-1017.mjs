import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import ts from 'typescript'
import { registerHooks } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-codearts-1017-'))
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
      if (fs.existsSync(new URL(tsCandidate))) {
        return { url: tsCandidate.href, shortCircuit: true }
      }
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
  const modelsMod = await import(pathToFileURL(path.join(repoRoot, 'vendor/channel-pack/src/models.ts')).href)

  // Case 1: Credit-package account (/v1/model/builtin returns dsv4.1f + dsv4.1f-1017, disabled/hidden/VL, and edge context_window values)
  const mockFetcher1 = async (url) => {
    if (String(url).includes('gateway/config')) {
      return new Response(JSON.stringify({ error_code: '4000', error_msg: 'invalid channel, group not found', result: null }), { status: 200 })
    }
    if (String(url).includes('/v1/model/builtin')) {
      return new Response(JSON.stringify({
        count: 7,
        builtinModels: [
          { model_id: 'deepseek-v4.1-flash', model_name: 'DeepSeek-V4.1-Flash', enable: true, display_enabled: true, context_window: 0 },
          { model_id: 'deepseek-v4.1-flash-1017', model_name: 'DeepSeek-V4.1-Flash-1017', enable: true, display_enabled: true, context_window: 1048576 },
          { model_id: 'custom-neg-cw', model_name: 'Custom-Neg', enable: true, display_enabled: true, context_window: -1 },
          { model_id: 'disabled-model-1017', model_name: 'Disabled', enable: false, display_enabled: true, context_window: 128000 },
          { model_id: 'hidden-model-0901', model_name: 'Hidden', enable: true, display_enabled: false, context_window: 128000 },
          { model_id: 'Qwen3-VL-235B', model_name: 'Qwen3-VL-235B', enable: true, display_enabled: true, context_window: 32768 },
        ],
      }), { status: 200 })
    }
    throw new Error(`Unexpected URL: ${url}`)
  }

  const list1 = await modelsMod.fetchCodeArtsRemoteModels(
    { access_key_id: 'AK_TEST', secret_access_key: 'SK_TEST', security_token: 'ST_TEST', expires_at: new Date(Date.now() + 3600_000).toISOString() },
    mockFetcher1,
  )
  assert.deepEqual(list1, [
    { id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash' },
    { id: 'deepseek-v4.1-flash-1017', name: 'DeepSeek-V4.1-Flash-1017', contextWindow: 1048576 },
    { id: 'custom-neg-cw', name: 'Custom-Neg' },
  ])
  console.log('✓ 场景 1 通过：保留双版本，过滤 enable=false / display_enabled=false / VL，忽略 0 与负数 context_window')

  // Case 2: gateway/config legacy -0731 normalization & benefit exclusion intact
  const mockFetcher2 = async (url) => {
    if (String(url).includes('gateway/config')) {
      return new Response(JSON.stringify({
        result: {
          models: [
            { model_id: 'deepseek-v4-flash-0731', model_name: 'DeepSeek-V4-Flash-0731' },
            { model_id: 'glm-5.3-flash', model_name: 'GLM-5.3-Flash' },
          ],
        },
      }), { status: 200 })
    }
    return new Response(JSON.stringify({ count: 0, builtinModels: [] }), { status: 200 })
  }
  const list2 = await modelsMod.fetchCodeArtsRemoteModels(
    { access_key_id: 'AK_TEST', secret_access_key: 'SK_TEST', security_token: 'ST_TEST', expires_at: new Date(Date.now() + 3600_000).toISOString() },
    mockFetcher2,
  )
  assert.deepEqual(list2.map((m) => m.id), ['deepseek-v4-flash', 'glm-5.3-flash'])
  assert.equal(modelsMod.isCodeArtsBenefitModel('glm-5.3-flash'), true)
  assert.equal(modelsMod.isCodeArtsBenefitModel('deepseek-v4-flash'), false)
  console.log('✓ 场景 2 通过：gateway/config 历史 -0731 归一化与 benefit 集合隔离保持不变')

  // Case 3: Bundled pack.js CodeArtsAdapter end-to-end listAllModels + resolveModel fallback & remote contextWindow
  const adapters = new Map()
  const creds = new Map()
  const services = {
    profileContext: { home: scratch },
    credentials: {
      resolve: async (ref) => creds.get(ref),
      describe: async () => undefined,
      set: async (ref, value) => { creds.set(ref, { value }) },
      unset: async (ref) => { creds.delete(ref) },
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

  const codeartsAdapter = adapters.get('codearts')
  assert.ok(codeartsAdapter, 'codearts adapter must be registered in pack.js')

  // Without remote fetch (no account yet), static DEFAULT_MODELS & CONTEXT_WINDOWS cover both dsv4.1f and dsv4.1f-1017
  const defaultIds = codeartsAdapter.listAllModels().map((m) => m.id)
  assert.equal(defaultIds.includes('deepseek-v4.1-flash'), true)
  assert.equal(defaultIds.includes('deepseek-v4.1-flash-1017'), true)

  const resolved1017 = await codeartsAdapter.resolveModel('codearts', 'deepseek-v4.1-flash-1017')
  assert.equal(resolved1017.context?.contextWindow, 1_048_576)
  const resolvedBase = await codeartsAdapter.resolveModel('codearts', 'deepseek-v4.1-flash')
  assert.equal(resolvedBase.context?.contextWindow, 1_000_000)
  const resolvedUnknown = await codeartsAdapter.resolveModel('codearts', 'unknown-custom-model')
  assert.equal(resolvedUnknown.context, undefined)
  console.log('✓ 场景 3 通过：pack.js 中 CodeArtsAdapter 同时列出两个版本且 resolveModel 上下文窗口回退正常')

  console.log('ALL CODEARTS 1017 MODEL LIST CHECKS PASSED!')
} finally {
  for (const cleanup of dispose.reverse()) await cleanup()
  hooks.deregister()
  fs.rmSync(scratch, { recursive: true, force: true })
}
