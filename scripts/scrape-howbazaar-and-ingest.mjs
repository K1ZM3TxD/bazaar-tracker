import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'
import { chromium } from 'playwright'

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

function chunk(arr, size) {
  const out = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

/**
 * Extract item cards by looking for a block that:
 * - contains an <img>
 * - has multiple lines of text
 * First line => item name
 * Later short words => tags
 */
function normalizeTag(t) {
  return t.replace(/\s+/g, ' ').trim()
}

async function main() {
  const headed = (process.env.PLAYWRIGHT_HEADLESS || '').toLowerCase() === 'false'

  const browser = await chromium.launch({ headless: !headed })
  const page = await browser.newPage({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
  })

  console.log('Opening HowBazaar items page...')
  await page.goto('https://www.howbazaar.gg/items', {
    waitUntil: 'domcontentloaded',
    timeout: 120000,
  })

  await page.waitForTimeout(6000)

  // scroll to load more
  for (let i = 0; i < 12; i++) {
    await page.mouse.wheel(0, 3000)
    await page.waitForTimeout(1000)
  }

  const scraped = await page.evaluate(() => {
    // Heuristic: item "cards" tend to be containers with an image + text lines
    const candidates = Array.from(document.querySelectorAll('div'))
    const results = []

    for (const el of candidates) {
      const img = el.querySelector('img')
      if (!img) continue

      const text = (el.innerText || '').trim()
      if (!text) continue

      const lines = text
        .split('\n')
        .map(s => s.trim())
        .filter(Boolean)

      // We expect at least a name + some details
      if (lines.length < 2) continue

      const name = lines[0]
      if (!name || name.length < 2 || name.length > 60) continue

      // Gather possible tags from remaining lines:
      // keep short-ish tokens that look like words (not numbers/percentages)
      const possible = []
      for (const line of lines.slice(1)) {
        const cleaned = line.replace(/\s+/g, ' ').trim()
        if (!cleaned) continue
        if (cleaned.length > 25) continue
        if (/[0-9]/.test(cleaned)) continue
        possible.push(cleaned)
      }

      // Best-effort source URL: if any ancestor is an <a>, use it
      let href = null
      const a = el.closest('a')
      if (a) href = a.getAttribute('href')

      results.push({
        name,
        tags: Array.from(new Set(possible)),
        href,
      })
    }

    // Deduplicate by name (keep the one with most tags)
    const byName = new Map()
    for (const r of results) {
      const prev = byName.get(r.name)
      if (!prev || (r.tags?.length || 0) > (prev.tags?.length || 0)) {
        byName.set(r.name, r)
      }
    }

    return Array.from(byName.values())
  })

  await browser.close()

  // Clean + finalize rows
  const rows = scraped
    .map(r => {
      const source_url = r.href
        ? (r.href.startsWith('http') ? r.href : `https://www.howbazaar.gg${r.href}`)
        : null

      const tags = (r.tags || [])
        .map(t => normalizeTag(t))
        .filter(Boolean)
        .filter(t => t.length <= 25)

      return {
        name: r.name.replace(/\s+/g, ' ').trim(),
        tags: tags.length ? tags : null,
        source_url,
      }
    })
    // remove obvious non-item rows (these were showing up in your first run)
    .filter(r => {
      const bad = new Set([
        'Heavy','Regen','Property','Core','Cooldown','Shielded','Economy','Vehicle','Turbo','Obsidian',
        'Radiant','Icy','Fiery','Golden','Shiny','Deadly','Toxic'
      ])
      return !bad.has(r.name)
    })

  console.log('Scraped candidate cards:', scraped.length)
  console.log('Final rows:', rows.length)
  console.log('First 10 rows:', rows.slice(0, 10))

  if (rows.length === 0) {
    console.error('No rows extracted. Site markup likely changed.')
    process.exit(1)
  }

  // Upsert (requires the unique index on name — which you added)
  for (const batch of chunk(rows, 300)) {
    const { error } = await supabase
      .from('items')
      .upsert(batch, { onConflict: 'name' })
    if (error) {
      console.error('Upsert failed:', error)
      process.exit(1)
    }
    console.log('Upserted batch:', batch.length)
  }

  console.log('✅ Done — names/tags/source_url upserted')
}

main().catch(err => {
  console.error('ERROR:', err)
  process.exit(1)
})
