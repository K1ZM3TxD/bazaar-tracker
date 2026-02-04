import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'
import { chromium } from 'playwright'
import { load } from 'cheerio'


const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

// MVP limit so this stays fast + proof-of-concept friendly
const MAX_ITEMS = Number(process.env.MAX_ITEMS || 200)

function chunk(arr, size) {
  const out = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms))
}

async function collectItemLinks() {
  const headed = (process.env.PLAYWRIGHT_HEADLESS || '').toLowerCase() === 'false'
  const browser = await chromium.launch({ headless: !headed })
  const page = await browser.newPage({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
  })

  console.log('Opening items grid...')
  await page.goto('https://www.howbazaar.gg/items', {
    waitUntil: 'domcontentloaded',
    timeout: 120000,
  })

  await page.waitForTimeout(6000)

  // Scroll to load a lot of items
  for (let i = 0; i < 35; i++) {
    await page.mouse.wheel(0, 4500)
    await page.waitForTimeout(700)
  }

  // The paperclip icon is an <a href="/items/..."> on the card
  const links = await page.evaluate(() => {
    const out = []
    const anchors = Array.from(document.querySelectorAll('a[href^="/items/"]'))
    for (const a of anchors) {
      const href = a.getAttribute('href')
      if (!href) continue
      if (href === '/items') continue
      out.push(new URL(href, location.origin).toString())
    }
    return Array.from(new Set(out))
  })

  await browser.close()

  console.log('Found item links:', links.length)
  return links
}

async function fetchItemNameAndImage(url) {
  const res = await fetch(url, {
    headers: {
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
      accept: 'text/html,*/*',
    },
  })

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}`)
  }

  const html = await res.text()
  const $ = load(html)



  // Name: usually the main <h1>
  const name =
    ($('h1').first().text() || '').replace(/\s+/g, ' ').trim() ||
    ($('title').text() || '').replace(/\s+/g, ' ').trim()

  // Image: prefer OG image
  let image_url = $('meta[property="og:image"]').attr('content') || ''
  image_url = (image_url || '').trim()

  // Fallback: first decent-looking image on the page
  if (!image_url) {
    const img = $('img').first().attr('src') || ''
    image_url = (img || '').trim()
  }

  // Normalize relative -> absolute
  if (image_url && image_url.startsWith('/')) {
    image_url = new URL(image_url, url).toString()
  }

  return {
    name,
    image_url: image_url || null,
    source_url: url,
  }
}

async function main() {
  const links = await collectItemLinks()

  if (!links.length) {
    console.log('0 links found. If the page is still open in a browser, confirm you can see the paperclip links.')
    process.exit(1)
  }

  const limited = links.slice(0, MAX_ITEMS)
  console.log(`Processing ${limited.length} item pages (MAX_ITEMS=${MAX_ITEMS})...`)

  const rows = []
  for (let i = 0; i < limited.length; i++) {
    const url = limited[i]
    try {
      const r = await fetchItemNameAndImage(url)

      // basic sanity: name should not be empty
      if (r.name && r.name.length >= 2) {
        rows.push({ name: r.name, image_url: r.image_url, source_url: r.source_url })
      } else {
        console.log('Skipped (no name):', url)
      }
    } catch (e) {
      console.log('Failed:', url, '-', e.message)
    }

    // tiny delay so we don’t hammer the site
    await sleep(80)
    if ((i + 1) % 25 === 0) console.log(`...processed ${i + 1}/${limited.length}`)
  }

  console.log('Rows ready to upsert:', rows.length)
  console.log('Sample:', rows.slice(0, 3))

  // Upsert by name (you already added a unique index on name)
  for (const batch of chunk(rows, 200)) {
    const { error } = await supabase
      .from('items')
      .upsert(batch, { onConflict: 'name' })

    if (error) {
      console.error('Upsert failed:', error)
      process.exit(1)
    }
    console.log('Upserted batch:', batch.length)
  }

  console.log('✅ Done — item name + image_url are in Supabase')
}

main().catch((err) => {
  console.error('ERROR:', err)
  process.exit(1)
})
