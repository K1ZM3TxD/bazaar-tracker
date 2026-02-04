import fs from 'fs'
import { chromium } from 'playwright'

async function main() {
  const browser = await chromium.launch({ headless: false })
  const page = await browser.newPage()

  console.log('Opening items grid...')
  await page.goto('https://www.howbazaar.gg/items', { waitUntil: 'domcontentloaded', timeout: 120000 })
  await page.waitForTimeout(6000)

  // Scroll a bunch to load everything the grid will reveal
  for (let i = 0; i < 25; i++) {
    await page.mouse.wheel(0, 4000)
    await page.waitForTimeout(800)
  }

  // Collect ALL links on the page and filter to item detail pages
  const urls = await page.evaluate(() => {
    const out = []
    for (const a of document.querySelectorAll('a[href]')) {
      const href = a.getAttribute('href') || ''
      if (!href.startsWith('/items/')) continue
      if (href === '/items') continue
      out.push(new URL(href, location.origin).toString())
    }
    return Array.from(new Set(out))
  })

  await browser.close()

  console.log('Found item URLs:', urls.length)
  fs.writeFileSync('item-urls.json', JSON.stringify(urls, null, 2), 'utf8')
  console.log('Saved item-urls.json')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
