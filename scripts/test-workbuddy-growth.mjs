import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import esbuild from 'esbuild'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.join(__dirname, '..')

// 通过 esbuild 动态将 TS 源码打包解析，无需任何前置编译步骤即可直接运行测试
const buildResult = await esbuild.build({
  stdin: {
    contents: `
      export { claimDailyCheckin, fetchCheckinStatus } from './vendor/channel-pack/src/buddy-credits.ts'
      export { CODEBUDDY } from './vendor/channel-pack/src/product.ts'
    `,
    resolveDir: rootDir,
    sourcefile: 'test-entry.ts',
    loader: 'ts',
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
})

const code = buildResult.outputFiles[0].text
const moduleUrl = `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
const { claimDailyCheckin, fetchCheckinStatus, CODEBUDDY } = await import(moduleUrl)

console.log('Testing WorkBuddy Growth Center checkin & activity integration...')

const mockCredential = {
  access_token: 'test_token_123',
  user_id: 'user_456',
  enterprise_id: '',
  domain: 'copilot.tencent.com',
}

// 模拟网络请求路由器
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

// Case 1: 首次签到（100 积分） + 成长中心全量奖励到账
{
  const mockFetcher = createMockFetcher({
    // 加油站每日签到
    '/v2/billing/meter/daily-checkin': () => ({
      body: { code: 0, data: { credit: 100, streak_days: 5, is_streak_day: false, message: '签到成功' } },
    }),
    // 宠物旅行状态（已归来待领礼物）
    '/v2/activity/growth/buddy/travel/status': () => ({
      body: { code: 0, data: { state: 'arrived', record_id: 'rec_999', daily_limit_reached: false } },
    }),
    // 领取旅行礼物
    '/v2/activity/growth/buddy/travel/claim': () => ({
      body: { code: 0, data: { reward_credit: 30 } },
    }),
    // 任务列表（1个待接单，1个已完成待领奖）
    '/v2/activity/growth/tasks': () => ({
      body: {
        code: 0,
        data: {
          tasks: [
            { task_code: 'task_daily_chat', title: '每日对话', accept_status: 'not_accepted', locked: false },
            { task_code: 'task_code_gen', title: '代码生成', accept_status: 'completed', reward_credit: 50, locked: false },
          ],
        },
      },
    }),
    // 批量接任务
    '/v2/activity/growth/tasks/accept': () => ({
      body: { code: 0, data: { success: true } },
    }),
    // 领任务奖
    '/v2/activity/growth/tasks/task_code_gen/claim': () => ({
      body: { code: 0, data: { credit: 50 } },
    }),
    // 连登与补签（0张补签卡）
    '/v2/activity/growth/streak': () => ({
      body: { code: 0, data: { makeup_cards: { balance: 0 }, streak: { days: 5 } } },
    }),
    // 连登兑换摘要（7天已解锁）
    '/v2/activity/growth/redeem/summary': () => ({
      body: { code: 0, data: { starter_status: 'available', advanced_status: 'locked', legendary_status: 'locked' } },
    }),
    // 连登兑换
    '/v2/activity/growth/redeem': () => ({
      body: { code: 0, data: { credit_granted: 100 } },
    }),
    // 盲盒抽奖机会
    '/v2/activity/growth/lottery/chances': () => ({
      body: { code: 0, data: { balance: 1 } },
    }),
    // 抽盲盒
    '/v2/activity/growth/lottery/draw': () => ({
      body: { code: 0, data: { prize_name: '50 算力积分', reward_credit: 50 } },
    }),
  })

  const outcome = await claimDailyCheckin(mockCredential, CODEBUDDY, mockFetcher)
  assert.equal(outcome.kind, 'claimed')
  // 100(签到) + 30(旅行) + 50(任务) + 100(7天兑换) + 50(盲盒) = 330 积分
  assert.equal(outcome.credit, 330, `预期总积分 330，实际为 ${outcome.credit}`)
  assert.equal(outcome.streakDays, 5)
  assert.ok(outcome.delayedMessage?.includes('领旅行礼物 +30 积分'))
  assert.ok(outcome.delayedMessage?.includes('自动接取 1 个成长任务'))
  assert.ok(outcome.delayedMessage?.includes('领任务奖「代码生成」+50 积分'))
  assert.ok(outcome.delayedMessage?.includes('连登兑换「7天连登」+100 积分'))
  assert.ok(outcome.delayedMessage?.includes('开盲盒获得「50 算力积分」+50积分'))
  console.log('✓ 场景 1 通过：每日签到 + 成长中心多重积分合并计算正常（获得 330 积分）')
}

// Case 2: 今日已签到（code 10001），但成长中心有旅行礼物或任务奖
{
  const mockFetcher = createMockFetcher({
    '/v2/billing/meter/daily-checkin': () => ({
      status: 400,
      body: { code: 10001, msg: '今天已签到，请明天再来' },
    }),
    '/v2/activity/growth/buddy/travel/status': () => ({
      body: { code: 0, data: { state: 'arrived', record_id: 'rec_888', daily_limit_reached: false } },
    }),
    '/v2/activity/growth/buddy/travel/claim': () => ({
      body: { code: 0, data: { reward_credit: 20 } },
    }),
    '/v2/activity/growth/tasks': () => ({
      body: { code: 0, data: { tasks: [] } },
    }),
    '/v2/activity/growth/streak': () => ({
      body: { code: 0, data: { makeup_cards: 0 } },
    }),
    '/v2/activity/growth/redeem/summary': () => ({
      body: { code: 0, data: { starter_status: 'claimed', advanced_status: 'locked' } },
    }),
    '/v2/activity/growth/lottery/chances': () => ({
      body: { code: 0, data: { balance: 0 } },
    }),
  })

  const outcome = await claimDailyCheckin(mockCredential, CODEBUDDY, mockFetcher)
  assert.equal(outcome.kind, 'claimed')
  assert.equal(outcome.credit, 20)
  assert.ok(outcome.delayedMessage?.includes('成长中心 +20 积分'))
  console.log('✓ 场景 2 通过：每日签到虽已签，但成长中心补领到 20 积分并正确返回 claimed')
}

// Case 3: 今日已签到且成长中心无新奖励（幂等）
{
  const mockFetcher = createMockFetcher({
    '/v2/billing/meter/daily-checkin': () => ({
      status: 400,
      body: { code: 10001, msg: '今天已签到，请明天再来' },
    }),
    '/v2/activity/growth/buddy/travel/status': () => ({
      body: { code: 0, data: { state: 'traveling', location: { name: '腾讯滨海大厦' } } },
    }),
    '/v2/activity/growth/tasks': () => ({
      body: { code: 0, data: { tasks: [] } },
    }),
    '/v2/activity/growth/streak': () => ({
      body: { code: 0, data: { makeup_cards: 0 } },
    }),
    '/v2/activity/growth/redeem/summary': () => ({
      body: { code: 0, data: { starter_status: 'claimed' } },
    }),
    '/v2/activity/growth/lottery/chances': () => ({
      body: { code: 0, data: { balance: 0 } },
    }),
  })

  const outcome = await claimDailyCheckin(mockCredential, CODEBUDDY, mockFetcher)
  assert.equal(outcome.kind, 'already-claimed')
  assert.ok(outcome.message.includes('Buddy 旅行中（腾讯滨海大厦）'))
  console.log('✓ 场景 3 通过：幂等检测正常，带出旅行在途状态')
}

console.log('ALL WORKBUDDY GROWTH VERIFICATION CHECKS PASSED!')
