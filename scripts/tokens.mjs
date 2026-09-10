import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { parse } from 'yaml'

const source = await readFile(new URL('../DESIGN.md', import.meta.url), 'utf8')
const data = parse(source.split('---')[1])
const lines = ['/* Generated from DESIGN.md by scripts/tokens.mjs. */', ':root {']
for (const [name, value] of Object.entries(data.colors)) lines.push(`  --color-${name}: ${value};`)
for (const [name, value] of Object.entries(data.typography))
  lines.push(`  --font-${name}: ${value.fontFamily};`)
for (const [name, value] of Object.entries(data.rounded))
  lines.push(`  --radius-${name}: ${value};`)
for (const [name, value] of Object.entries(data.spacing)) lines.push(`  --space-${name}: ${value};`)
lines.push('}', '')
await mkdir(new URL('../src/renderer/styles/', import.meta.url), { recursive: true })
await writeFile(new URL('../src/renderer/styles/tokens.css', import.meta.url), lines.join('\n'))
await writeFile(
  new URL('../src/shared/design-tokens.json', import.meta.url),
  JSON.stringify(data.colors, null, 2) + '\n',
)
