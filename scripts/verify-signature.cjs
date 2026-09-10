const { execFileSync } = require('node:child_process')
const { existsSync } = require('node:fs')
const { join } = require('node:path')

/**
 * A build that stops partway through signing still leaves an app on disk. Without this the first
 * sign that anything is wrong is a bundle that will not verify, long after it has been installed.
 */
module.exports = async function verifySignature(context) {
  if (context.electronPlatformName !== 'darwin') return
  const app = join(context.appOutDir, 'Jarvis.app')
  if (!existsSync(join(app, 'Contents/_CodeSignature/CodeResources')))
    throw new Error('The signed bundle has no resource seal. Signing did not finish.')
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'pipe' })
  console.log('  • resource seal present and signature verifies')
}
