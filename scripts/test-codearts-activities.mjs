import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import esbuild from 'esbuild'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.join(__dirname, '..')

// 通过 esbuild 动态打包生成临时模块测试
const tempFile = path.join(__dirname, '.test-codearts-bundle.mjs')
await esbuild.build({
  stdin: {
    contents: `
      export {
        claimCodeArtsDailyCheckin,
        claimCodeArtsAllActivities,
        fetchCodeArtsAccountInfoDetailed,
        fetchCodeArtsOpsActivitiesDetailed,
      } from './vendor/channel-pack/src/codearts-credits.ts'
    `,
    resolveDir: rootDir,
    sourcefile: 'test-codearts-entry.ts',
    loader: 'ts',
  },
  bundle: true,
  packages: 'external',
  outfile: tempFile,
  format: 'esm',
  platform: 'node',
})

let claimCodeArtsDailyCheckin, claimCodeArtsAllActivities
try {
  const mod = await import(pathToFileURL(tempFile).href)
  claimCodeArtsDailyCheckin = mod.claimCodeArtsDailyCheckin
  claimCodeArtsAllActivities = mod.claimCodeArtsAllActivities
} finally {
  try {
    fs.unlinkSync(tempFile)
  } catch {}
}

console.log('Testing CodeArts Multi-Activity checkin & claim integration...')

const mockCredential = {
  access_key_id: 'test_ak_123',
  secret_access_key: 'test_sk_456',
  security_token: 'test_st_789',
}

function createMockFetcher(handlers = {}) {
  return async (url, options = {}) => {
    const urlStr = String(url)
    const method = options.method || 'GET'
    const pathname = new URL(urlStr).pathname

    if (handlers[pathname]) {
      const resp = handlers[pathname](method, options)
      return {
        status: resp.status || 200,
        ok: (resp.status || 200) < 400,
        text: async () => JSON.stringify(resp.body || {}),
      }
    }

    return {
      status: 404,
      ok: false,
      text: async () => JSON.stringify({ code: 404, msg: 'Not found' }),
    }
  }
}

// 场景 1: 单一每日签到（USER_LOGIN 100 积分）成功
{
  const mockFetcher = createMockFetcher({
    '/snap-manager/v1/statistics/plugin': () => ({
      body: {
        package: { is_credit_package: true, is_token_package: false, status: 'NORMAL' },
        metrics: [{ name: 'usageTotalPackageCredit', package_credit_remain: 100 }],
      },
    }),
    '/v1/ops/delivery': () => ({
      body: {
        code: 0,
        data: {
          items: [
            { campaignId: 1, type: 'USER_LOGIN', title: '每日签到', claimable: true, status: 'ENTRY', benefitAmount: 100 },
          ],
        },
      },
    }),
    '/v1/ops/claim': (_method, options) => {
      const body = JSON.parse(options.body)
      assert.equal(body.campaignId, '1')
      return { body: { code: 0, data: { id: 'benefit_001', benefitAmount: 100 } } }
    },
    '/v1/ops/confirm': () => ({
      body: { code: 0, data: { success: true } },
    }),
  })

  const outcome = await claimCodeArtsDailyCheckin(mockCredential, mockFetcher)
  assert.equal(outcome.kind, 'claimed')
  assert.equal(outcome.credit, 100)
  assert.equal(outcome.delayedMessage, undefined) // 单个活动领取无冗余 delayedMessage
  console.log('✓ 场景 1 通过：单一每日签到正常领取 100 积分')
}

// 场景 2: 多活动并发（每日登录 100 + 新人注册礼包 1000 + 社区限时活动 500 = 1600 积分）
{
  const claimedCampaigns = []
  const confirmedCampaigns = []

  const mockFetcher = createMockFetcher({
    '/snap-manager/v1/statistics/plugin': () => ({
      body: {
        package: { is_credit_package: true, is_token_package: false },
        metrics: [],
      },
    }),
    '/v1/ops/delivery': () => ({
      body: {
        code: 0,
        data: {
          items: [
            { campaignId: 1, type: 'USER_LOGIN', title: '每日登录', claimable: true, status: 'ENTRY', benefitAmount: 100 },
            { campaignId: 2, type: 'NEW_USER_REGISTER', title: '新人注册大礼包', claimable: true, status: 'ENTRY', benefitAmount: 1000 },
            { campaignId: 3, type: 'FESTIVAL_SPECIAL', title: '限时开发者狂欢', claimable: true, status: 'ENTRY', benefitAmount: 500 },
          ],
        },
      },
    }),
    '/v1/ops/claim': (_method, options) => {
      const body = JSON.parse(options.body)
      claimedCampaigns.push(body.campaignId)
      const credits = { '1': 100, '2': 1000, '3': 500 }
      return { body: { code: 0, data: { id: `ben_${body.campaignId}`, benefitAmount: credits[body.campaignId] } } }
    },
    '/v1/ops/confirm': (_method, options) => {
      const body = JSON.parse(options.body)
      confirmedCampaigns.push(body.campaignId)
      return { body: { code: 0, data: { success: true } } }
    },
  })

  const outcome = await claimCodeArtsDailyCheckin(mockCredential, mockFetcher)
  assert.equal(outcome.kind, 'claimed')
  assert.equal(outcome.credit, 1600)
  assert.deepEqual(claimedCampaigns, ['1', '2', '3'])
  assert.deepEqual(confirmedCampaigns, ['1', '2', '3'])
  assert.ok(outcome.delayedMessage?.includes('每日登录+100积分'))
  assert.ok(outcome.delayedMessage?.includes('新人注册大礼包+1000积分'))
  assert.ok(outcome.delayedMessage?.includes('限时开发者狂欢+500积分'))
  console.log('✓ 场景 2 通过：多活动聚合扫描与领取正常（累计到账 1600 积分）')
}

// 场景 3: 幂等（所有活动均已在 CLAIMED 状态）
{
  const mockFetcher = createMockFetcher({
    '/snap-manager/v1/statistics/plugin': () => ({
      body: { package: { is_credit_package: true } },
    }),
    '/v1/ops/delivery': () => ({
      body: {
        code: 0,
        data: {
          items: [
            { campaignId: 1, type: 'USER_LOGIN', title: '每日签到', claimable: false, status: 'CLAIMED', benefitAmount: 100 },
            { campaignId: 2, type: 'NEW_USER_REGISTER', title: '新人礼包', claimable: false, status: 'CLAIMED', benefitAmount: 1000 },
          ],
        },
      },
    }),
  })

  const outcome = await claimCodeArtsDailyCheckin(mockCredential, mockFetcher)
  assert.equal(outcome.kind, 'already-claimed')
  assert.equal(outcome.message, '今天已领取')
  console.log('✓ 场景 3 通过：幂等检测正常，已领状态返回 already-claimed')
}

// 场景 4: 非积分计费账户（Token 版账户）
{
  const mockFetcher = createMockFetcher({
    '/snap-manager/v1/statistics/plugin': () => ({
      body: { package: { is_credit_package: false, is_token_package: true } },
    }),
  })

  const outcome = await claimCodeArtsDailyCheckin(mockCredential, mockFetcher)
  assert.equal(outcome.kind, 'inactive')
  assert.ok(outcome.message.includes('Token 计费账户'))
  console.log('✓ 场景 4 通过：Token 计费账户安全识别为 inactive')
}

// 场景 5: 部分成功部分失败
{
  const mockFetcher = createMockFetcher({
    '/snap-manager/v1/statistics/plugin': () => ({
      body: { package: { is_credit_package: true } },
    }),
    '/v1/ops/delivery': () => ({
      body: {
        code: 0,
        data: {
          items: [
            { campaignId: 1, type: 'USER_LOGIN', title: '每日登录', claimable: true, status: 'ENTRY', benefitAmount: 100 },
            { campaignId: 99, type: 'EXPIRED_EVENT', title: '过期活动', claimable: true, status: 'ENTRY', benefitAmount: 200 },
          ],
        },
      },
    }),
    '/v1/ops/claim': (_method, options) => {
      const body = JSON.parse(options.body)
      if (body.campaignId === '1') {
        return { body: { code: 0, data: { benefitAmount: 100 } } }
      }
      return { status: 400, body: { code: 40001, msg: '活动已过期' } }
    },
  })

  const outcome = await claimCodeArtsDailyCheckin(mockCredential, mockFetcher)
  assert.equal(outcome.kind, 'claimed')
  assert.equal(outcome.credit, 100)
  assert.ok(outcome.delayedMessage?.includes('每日登录+100积分'))
  assert.ok(outcome.delayedMessage?.includes('部分失败'))
  console.log('✓ 场景 5 通过：部分失败容错正常，成功项积分正确入账并标注失败原因')
}

console.log('ALL CODEARTS ACTIVITIES VERIFICATION CHECKS PASSED!')
