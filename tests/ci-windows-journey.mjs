// REAL-Windows journey for CI (GitHub Actions windows-latest): drives the
// INSTALLED packaged exe through the new-tester flow. Runners have no audio
// hardware — mic/loopback failing gracefully is EXPECTED and captured, not a
// failure. What this proves on Windows: install, launch, auth gate, sign-up,
// account isolation, Deepgram connect via proxy credential, meeting save,
// cloud sync, sign-out.
// Env: FRAGOLA_EXE = path to installed Fragola.exe

import { _electron } from 'playwright'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'

const EXE = process.env.FRAGOLA_EXE
if (!EXE) throw new Error('FRAGOLA_EXE not set')
const OUT = 'ci-screens'
mkdirSync(OUT, { recursive: true })

const STAMP = `${Date.now()}`.slice(-6)
const EMAIL = `fragola-citester-${STAMP}@mailinator.com`
const PASSWORD = `Ci${STAMP}x!aa`
const result = { email: EMAIL, platform: process.platform }

console.log(`[ci] launching installed exe: ${EXE}`)
const app = await _electron.launch({ executablePath: EXE })
let page = await app.firstWindow()
if (page.url().includes('floating')) {
  page = (await app.windows()).find((w) => !w.url().includes('floating')) ?? page
}
await page.waitForLoadState('domcontentloaded')
page.on('console', (m) => {
  const t = m.text()
  if (/SystemAudio|Deepgram|Sync|Auth/i.test(t)) console.log('[app]', t.slice(0, 180))
})

// 1. Auth gate on a pristine Windows machine
await page.waitForSelector('text=Sign in to your account', { timeout: 30_000 })
await page.screenshot({ path: join(OUT, 'w1-auth-gate.png') })
console.log('[ci] ✓ auth gate (Windows)')

// 2. Sign up through the real UI
await page.locator('text=Create one').click()
await page.fill('input[placeholder="Email"]', EMAIL)
await page.fill('input[placeholder="Password"]', PASSWORD)
await page.locator('button:has-text("Create account")').click()
await page.waitForSelector('input[placeholder="Search meetings..."]', { timeout: 30_000 })
result.signedUp = true
const meetingCount = await page.evaluate(() => window.__meetingStore.getState().meetings.length)
result.emptyList = meetingCount === 0
await page.screenshot({ path: join(OUT, 'w2-signed-up-empty.png') })
console.log(`[ci] ✓ signed up; meetings visible: ${meetingCount} (expect 0)`)

// 3. Start a meeting — Deepgram must connect via the proxy credential.
//    Mic + loopback may fail on an audio-less runner; that's the designed
//    degradation, not a product failure.
await page.locator('button:has-text("Start Meeting")').click()
await page.waitForFunction(
  () => window.__meetingStore.getState().state === 'recording',
  undefined,
  { timeout: 45_000 }
)
let dg = false
for (let i = 0; i < 15; i++) {
  await page.waitForTimeout(1000)
  dg = await page.evaluate(() => window.__meetingStore.getState().isDeepgramConnected)
  if (dg) break
}
result.recordingReached = true
result.deepgramConnectedViaProxy = dg
const notice = await page.evaluate(() => window.__meetingStore.getState().notice)
result.audioNotice = notice
console.log(`[ci] ✓ recording state; deepgram=${dg}; notice=${JSON.stringify(notice)}`)
await page.waitForTimeout(12_000)
await page.screenshot({ path: join(OUT, 'w3-recording.png') })

// 4. Stop → save → review
await page.locator('button:has-text("Stop Meeting")').click()
await page.waitForFunction(
  () => window.__meetingStore.getState().currentView === 'review',
  undefined,
  { timeout: 90_000 }
)
await page.waitForTimeout(2500)
result.savedAndReview = true
await page.screenshot({ path: join(OUT, 'w4-review.png') })
console.log('[ci] ✓ meeting saved, review opened')

// 5. Cloud sync row for this user
await page.waitForTimeout(6000)
const pull = await page.evaluate(() => window.fragola.sync.pullNow())
result.cloudTotal = pull.data?.total ?? -1
console.log(`[ci] cloud meetings for CI user: ${result.cloudTotal} (expect 1)`)

// 6. Sign out
await page.evaluate(() => window.__meetingStore.getState().setCurrentView('settings'))
await page.locator('button:has-text("Sign out")').click()
await page.waitForSelector('text=Sign in to your account', { timeout: 20_000 })
result.signedOut = true
await page.screenshot({ path: join(OUT, 'w5-signed-out.png') })
await app.close()

writeFileSync(join(OUT, 'result.json'), JSON.stringify(result, null, 2))
console.log('[ci] RESULT', JSON.stringify(result))

const hardFail =
  !result.signedUp || !result.emptyList || !result.recordingReached ||
  !result.deepgramConnectedViaProxy || !result.savedAndReview ||
  result.cloudTotal !== 1 || !result.signedOut
if (hardFail) {
  console.error('[ci] HARD FAIL — see result.json')
  process.exit(1)
}
console.log('[ci] ALL PRODUCT CHECKS PASSED ON WINDOWS')
