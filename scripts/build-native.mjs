import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
mkdirSync('native/build', { recursive: true })
const plist = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>personal.jarvis.native</string><key>CFBundleName</key><string>Jarvis</string><key>NSAppleEventsUsageDescription</key><string>Jarvis reads only the application context you explicitly share.</string><key>NSMicrophoneUsageDescription</key><string>Jarvis listens only when you activate the orb.</string><key>NSCalendarsFullAccessUsageDescription</key><string>Jarvis reads your calendar when you connect it.</string><key>NSRemindersFullAccessUsageDescription</key><string>Jarvis reads reminders when you connect them.</string></dict></plist>`
writeFileSync('native/build/Info.plist', plist)
writeFileSync(
  'native/build/AutomationInfo.plist',
  plist.replace('personal.jarvis.native', 'personal.jarvis.automation'),
)
const result = spawnSync(
  'xcrun',
  [
    'swiftc',
    '-swift-version',
    '5',
    '-O',
    '-target',
    'arm64-apple-macosx26.0',
    'native/JarvisNative.swift',
    '-o',
    'native/build/JarvisNative',
    '-framework',
    'AppKit',
    '-framework',
    'AVFoundation',
    '-framework',
    'EventKit',
    '-framework',
    'ScreenCaptureKit',
    '-framework',
    'Security',
    '-Xlinker',
    '-sectcreate',
    '-Xlinker',
    '__TEXT',
    '-Xlinker',
    '__info_plist',
    '-Xlinker',
    'native/build/Info.plist',
  ],
  { stdio: 'inherit' },
)
if (result.status !== 0) process.exit(result.status || 1)
const sign = spawnSync(
  'codesign',
  ['--force', '--sign', '-', '--identifier', 'personal.jarvis.native', 'native/build/JarvisNative'],
  { stdio: 'inherit' },
)
if (sign.status !== 0) process.exit(sign.status || 1)
const automation = spawnSync(
  'xcrun',
  [
    'swiftc',
    '-swift-version',
    '5',
    '-O',
    '-target',
    'arm64-apple-macosx26.0',
    'native/JarvisAutomation.swift',
    '-framework',
    'AppKit',
    '-Xlinker',
    '-sectcreate',
    '-Xlinker',
    '__TEXT',
    '-Xlinker',
    '__info_plist',
    '-Xlinker',
    'native/build/AutomationInfo.plist',
    '-o',
    'native/build/JarvisAutomation',
  ],
  { stdio: 'inherit' },
)
if (automation.status !== 0) process.exit(automation.status || 1)
const automationSign = spawnSync(
  'codesign',
  [
    '--force',
    '--sign',
    '-',
    '--identifier',
    'personal.jarvis.automation',
    'native/build/JarvisAutomation',
  ],
  { stdio: 'inherit' },
)
if (automationSign.status !== 0) process.exit(automationSign.status || 1)
// Keep the credential broker's identity stable across audio/helper revisions.
const brokerHash = createHash('sha256')
  .update(readFileSync('native/JarvisKeychain.swift'))
  .digest('hex')
const previous = existsSync('native/build/keychain-source.sha256')
  ? readFileSync('native/build/keychain-source.sha256', 'utf8')
  : ''
if (!existsSync('native/build/JarvisKeychain') || brokerHash !== previous) {
  const compile = spawnSync(
    'xcrun',
    [
      'swiftc',
      '-O',
      '-target',
      'arm64-apple-macosx26.0',
      'native/JarvisKeychain.swift',
      '-framework',
      'Security',
      '-o',
      'native/build/JarvisKeychain',
    ],
    { stdio: 'inherit' },
  )
  if (compile.status !== 0) process.exit(compile.status || 1)
  const signed = spawnSync(
    'codesign',
    [
      '--force',
      '--sign',
      '-',
      '--identifier',
      'personal.jarvis.keychain',
      'native/build/JarvisKeychain',
    ],
    { stdio: 'inherit' },
  )
  if (signed.status !== 0) process.exit(signed.status || 1)
  writeFileSync('native/build/keychain-source.sha256', brokerHash)
}
