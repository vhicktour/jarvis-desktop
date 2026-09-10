import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
mkdirSync('native/build/Jarvis.iconset', { recursive: true })
function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' })
  if (result.status !== 0) process.exit(result.status || 1)
}
run('xcrun', ['swift', 'native/MakeIcon.swift', 'native/build/icon-1024.png'])
for (const size of [16, 32, 128, 256, 512]) {
  for (const scale of [1, 2])
    run('sips', [
      '-z',
      String(size * scale),
      String(size * scale),
      'native/build/icon-1024.png',
      '--out',
      `native/build/Jarvis.iconset/icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`,
    ])
}
run('iconutil', ['-c', 'icns', 'native/build/Jarvis.iconset', '-o', 'native/build/Jarvis.icns'])
