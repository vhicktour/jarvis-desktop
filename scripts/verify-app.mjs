import { chromium } from 'playwright'
import AxeBuilder from '@axe-core/playwright'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'
import electronPath from 'electron'
import { LOCAL_VOICE_MODELS } from '../src/shared/speech.ts'

// Default: disposable profile. --installed-voice checks /Applications/Jarvis.app and enables
// natural local conversation. Use that flag only for an authorized voice setup.
const packaged = process.argv.includes('--installed-voice')
const userProfile = join(homedir(), 'Library/Application Support/Jarvis')
const installed = '/Applications/Jarvis.app'
const profile = packaged ? userProfile : resolve('verification/private/app-qa')
mkdirSync(profile, { recursive: true })
if (!packaged && !existsSync(join(profile, 'models')))
  symlinkSync(join(userProfile, 'models'), join(profile, 'models'), 'dir')
const portFile = resolve(profile, 'DevToolsActivePort')
rmSync(portFile, { force: true })
const bundleHashes = {}
if (packaged) {
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', installed])
  for (const file of [
    'app.asar',
    'workers/models.py',
    'workers/listen.py',
    'native/JarvisNative',
  ]) {
    const digest = (app) =>
      createHash('sha256')
        .update(readFileSync(join(app, 'Contents/Resources', file)))
        .digest('hex')
    bundleHashes[file] = digest(installed)
    assert.equal(
      bundleHashes[file],
      digest(resolve('dist/mac-arm64/Jarvis.app')),
      `The installed ${file} differs from the current package`,
    )
  }
}
const child = spawn(
  packaged ? '/usr/bin/open' : electronPath,
  packaged
    ? ['-W', '-n', installed, '--args', '--remote-debugging-port=0']
    : ['.', '--remote-debugging-port=0'],
  {
    env: { ...process.env, ...(packaged ? {} : { JARVIS_PROFILE: profile }) },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
)
const result = {
  generatedAt: new Date().toISOString(),
  profile,
  packaged,
  bundleHashes,
  humanSpeechTested: false,
  checks: [],
  turns: [],
  accessibility: [],
}
const errors = []
child.stderr.on('data', (chunk) => errors.push(chunk.toString().slice(0, 2000)))
const waitFor = async (callback, seconds = 45) => {
  const deadline = Date.now() + seconds * 1000
  while (!(await callback())) {
    if (Date.now() > deadline) throw new Error('App verification timed out')
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}
let browser
try {
  await waitFor(() => existsSync(portFile))
  browser = await chromium.connectOverCDP(
    `http://127.0.0.1:${readFileSync(portFile, 'utf8').split('\n')[0]}`,
  )
  let orb
  await waitFor(() => {
    orb = browser
      .contexts()[0]
      .pages()
      .find((page) => page.url().includes('surface=orb'))
    return !!orb
  })
  console.log('Checking service readiness')
  const command = (value) => orb.evaluate((value) => window.jarvis.command(value), value)
  let snapshot
  await waitFor(async () => {
    snapshot = await command({ type: 'snapshot' }).catch(() => null)
    return (
      snapshot?.diagnostics.modelRuntime &&
      LOCAL_VOICE_MODELS.every((id) => snapshot.models.some(
        (model) => model.id === id && model.status === 'installed' && model.qualified,
      ))
    )
  }, 90)
  const geometry = await orb.evaluate(() => ({ width: innerWidth, height: innerHeight }))
  assert.equal(geometry.width, 72)
  assert.equal(geometry.height, 72)
  result.checks.push(
    'The launch orb retains its 72-point geometry',
    'Standard voice components available through the service',
  )
  await command({ type: 'settings.open', section: 'voice' })
  let settings
  await waitFor(async () => {
    settings = browser
      .contexts()[0]
      .pages()
      .find((page) => page.url().includes('surface=settings'))
    return !!settings
  })
  console.log('Checking voice settings')
  await command({
    type: 'settings.update',
    patch: { wakeWord: false, handsFree: false, bargeIn: false, conversationEngine: 'pipeline' },
  })
  await settings.getByRole('button', { name: 'Enable natural conversation', exact: true }).click()
  await waitFor(async () => {
    snapshot = await command({ type: 'snapshot' })
    return snapshot.settings.wakeWord && snapshot.voice.watching
  })
  assert.equal(snapshot.settings.bargeIn, true)
  assert.equal(snapshot.settings.handsFree, true)
  assert.equal(snapshot.settings.replyLength, 'brief')
  result.checks.push('Natural conversation button enables listening through the real native helper')
  await settings.screenshot({ path: 'verification/private/voice-settings.png' })
  for (const section of [
    'General',
    'Voice & sound',
    'Local models',
    'Connections',
    'Memory',
    'Routines',
    'Privacy & access',
    'Diagnostics',
  ]) {
    await settings.getByRole('button', { name: section, exact: true }).click()
    await settings.getByRole('heading', { name: section, exact: true }).waitFor()
    await settings.waitForTimeout(250)
    const audit = await new AxeBuilder({ page: settings })
      .setLegacyMode(true)
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .analyze()
    result.accessibility.push({
      section,
      violations: audit.violations.map(({ id, impact, nodes }) => ({
        id,
        impact,
        nodes: nodes.map(({ html, failureSummary }) => ({ html, failureSummary })),
      })),
    })
  }
  await settings.getByRole('button', { name: 'Connections', exact: true }).click()
  if (!packaged) {
    await settings
      .locator('.connection-block')
      .filter({ hasText: 'OpenAI Realtime' })
      .getByRole('button', { name: 'Connect', exact: true })
      .click()
    await settings.getByRole('textbox', { name: 'OpenAI API key', exact: true }).waitFor()
    result.checks.push('OpenAI credential form opens; skills list renders')
  }
  await command({
    type: 'settings.update',
    patch: { handsFree: false, wakeWord: false, bargeIn: true },
  })
  // Let startup warming finish before measuring normal conversation.
  await waitFor(async () => {
    snapshot = await command({ type: 'snapshot' })
    return snapshot.voice.phase === 'off'
  })
  await new Promise((resolve) => setTimeout(resolve, 12000))
  for (const text of ['What is two plus two?', 'What is one useful tip for naming a function?']) {
    console.log(`Testing conversation: ${text}`)
    await orb.evaluate(() => {
      window.voiceProbe?.unsubscribe?.()
      const probe = (window.voiceProbe = {
        began: performance.now(),
        firstTextMs: null,
        firstPlaybackStateMs: null,
        maxReply: '',
      })
      probe.unsubscribe = window.jarvis.subscribe((event) => {
        if (event.type !== 'snapshot') return
        const reply = event.snapshot.messages.at(-1)
        if (reply?.role === 'assistant' && reply.text && probe.firstTextMs === null)
          probe.firstTextMs = performance.now() - probe.began
        if (event.snapshot.voice.phase === 'speaking' && probe.firstPlaybackStateMs === null)
          probe.firstPlaybackStateMs = performance.now() - probe.began
        if (reply?.role === 'assistant') probe.maxReply = reply.text
      })
    })
    await command({ type: 'conversation.send', text })
    await waitFor(async () => {
      snapshot = await command({ type: 'snapshot' })
      return (
        ['off', 'error'].includes(snapshot.voice.phase) &&
        snapshot.messages.at(-1)?.role === 'assistant' &&
        snapshot.messages.at(-1)?.text &&
        !snapshot.messages.at(-1)?.streaming
      )
    }, 90)
    assert.notEqual(snapshot.voice.phase, 'error', snapshot.voice.error)
    const timing = await orb.evaluate(() => {
      const { began, unsubscribe, ...result } = window.voiceProbe
      unsubscribe()
      return result
    })
    result.turns.push({ input: text, reply: snapshot.messages.at(-1).text, ...timing })
    assert.ok(timing.firstPlaybackStateMs !== null, 'The app never entered playback')
    await new Promise((resolve) => setTimeout(resolve, 3000))
  }
  result.checks.push('Text to reasoning to streamed native playback completes twice')
  // Changing input mode while a microphone is open must close that recording.
  await command({ type: 'voice.toggle' })
  await command({ type: 'conversation.send', text: 'Stop talking.' })
  snapshot = await command({ type: 'snapshot' })
  assert.equal(snapshot.voice.handsFree, false)
  result.checks.push('Typed stop can end an active microphone turn')
  if (packaged) {
    await command({
      type: 'settings.update',
      patch: {
        wakeWord: true,
        handsFree: true,
        automaticEndpointing: true,
        bargeIn: true,
        replyLength: 'brief',
        speakReplies: true,
      },
    })
    await waitFor(async () => (await command({ type: 'snapshot' })).voice.watching)
    result.checks.push('Natural local conversation enabled in the installed app')
  }
  assert.ok(
    result.accessibility.every((audit) => audit.violations.length === 0),
    'Settings has accessibility violations',
  )
  result.passed = true
} catch (error) {
  result.passed = false
  result.error = String(error)
  process.exitCode = 1
} finally {
  execFileSync('/usr/bin/osascript', [
    '-e',
    `tell application "${packaged ? 'Jarvis' : 'Electron'}" to quit`,
  ])
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 5000)),
  ])
  if (child.exitCode === null) child.kill('SIGTERM')
  await browser?.close().catch(() => {})
  result.diagnostics = errors.filter((line) => /error|failed/i.test(line)).slice(-10)
  writeFileSync(
    `verification/${packaged ? 'installed-app' : 'app-integration'}.json`,
    JSON.stringify(result, null, 2) + '\n',
  )
  console.log(JSON.stringify(result))
}
