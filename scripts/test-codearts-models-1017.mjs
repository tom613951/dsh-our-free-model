import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import ts from 'typescript'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'

const repoRoot = 'C:/Users/26503/.gemini/antigravity/scratch/dsh-our-free-model'
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-codearts-1017-'))
process.env.DSH_CODEARTS_CACHE_DIR = scratch

// Transpile models.ts + sign.ts + direct-fetch.js for isolated unit assertions
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
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

try {
  const modelsMod = await import(pathToFileURL(path.join(repoRoot, 'vendor/channel-pack/src/models.ts')).href)

  // Case 1: Credit-package account (opengw returns 4000, /v1/model/builtin returns both dsv4.1f and dsv4.1f-1017)
  const mockFetcher1 = async (url) => {
    if (String(url).includes('gateway/config')) {
      return new Response(JSON.stringify({ error_code: '4000', error_msg: 'invalid channel, group not found', result: null }), { status: 200 })
    }
    if (String(url).includes('/v1/model/builtin')) {
      return new Response(JSON.stringify({
        count: 4,
        builtinModels: [
          { model_id: 'deepseek-v4.1-flash', model_name: 'DeepSeek-V4.1-Flash', enable: true, display_enabled: true, context_window: 1048576 },
          { model_id: 'deepseek-v4.1-flash-1017', model_name: 'DeepSeek-V4.1-Flash-1017', enable: true, display_enabled: true, context_window: 1048576 },
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
    { id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash', contextWindow: 1048576 },
    { id: 'deepseek-v4.1-flash-1017', name: 'DeepSeek-V4.1-Flash-1017', contextWindow: 1048576 },
  ])
  console.log('✓ 场景 1 通过：/v1/model/builtin 同时保留 deepseek-v4.1-flash 与 deepseek-v4.1-flash-1017 及各自 contextWindow，过滤隐藏与 VL 模型')

  // Case 2: gateway/config legacy -0731 normalization & benefit exclusion still intact
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
  console.log('ALL CODEARTS 1017 MODEL LIST CHECKS PASSED!')
} finally {
  hooks.deregister()
  fs.rmSync(scratch, { recursive: true, force: true })
}
