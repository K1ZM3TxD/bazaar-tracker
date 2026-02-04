import 'dotenv/config'
import fs from 'fs'
import { parse } from 'csv-parse/sync'
import { createClient } from '@supabase/supabase-js'

// Supabase connection
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

// Read CSV
const csvText = fs.readFileSync('items.csv', 'utf8')

// Parse CSV into objects
const records = parse(csvText, {
  columns: true,
  skip_empty_lines: true,
})

// Map CSV rows → Supabase rows
const rows = records.map(r => ({
  name: r.name,
}))

console.log(`Inserting ${rows.length} items...`)

// Insert in one batch
const { error } = await supabase
  .from('items')
  .insert(rows)

if (error) {
  console.error('Insert failed:', error)
  process.exit(1)
}

console.log('✅ Ingestion complete')
