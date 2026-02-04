import fs from 'fs'

const html = fs.readFileSync('howbazaar-items.browser.html', 'utf8')

// grab every href/src="..."
const re = /(href|src)="([^"]+)"/g

const out = []
let m
while ((m = re.exec(html)) !== null) {
  const url = m[2]
  if (
    url.includes('.js') ||
    url.includes('.css') ||
    url.includes('/_app/') ||
    url.includes('_next')
  ) {
    out.push(url)
  }
}

const uniq = [...new Set(out)]
console.log('found', uniq.length, 'asset-ish urls')
console.log(uniq.slice(0, 50).join('\n'))
