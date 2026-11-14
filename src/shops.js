// Shops für die Einkaufsliste. Die ersten vier ("top") werden zuerst gezeigt.
const enc = encodeURIComponent

export const SHOPS = [
  { id: 'amazon', name: 'Amazon', top: true, domain: 'amazon.de', url: q => `https://www.amazon.de/s?k=${enc(q)}` },
  { id: 'conalco', name: 'Conalco', top: true, domain: 'conalco.de' },
  { id: 'delicando', name: 'Delicando', top: true, domain: 'delicando.com' },
  { id: 'drankdozijn', name: 'Drankdozijn', top: true, domain: 'drankdozijn.nl' },
  { id: 'superbillig', name: 'Spirituosen-Superbillig', domain: 'spirituosen-superbillig.com' },
  { id: 'perola', name: 'Perola', domain: 'perola-shop.de' },
  { id: 'myspirits', name: 'MySpirits', domain: 'myspirits.eu' },
  { id: 'weinquelle', name: 'Weinquelle Lühmann', domain: 'weinquelle.com' },
  { id: 'urban', name: 'Urban Drinks', domain: 'urban-drinks.de' },
  { id: 'berlinbottle', name: 'Berlin Bottle', domain: 'berlinbottle.de' },
]

// Suchlink: Amazon direkt, die anderen über eine Google-Suche innerhalb der Shop-Domain
export function shopLink(shop, query) {
  if (shop.url) return shop.url(query)
  return `https://www.google.com/search?q=${enc(`${query} site:${shop.domain}`)}`
}

export function productQuery(b) {
  const size = b.size_ml ? ` ${b.size_ml >= 1000 ? (b.size_ml / 1000).toString().replace('.', ',') + ' l' : b.size_ml + ' ml'}` : ''
  return `${b.brand} ${b.name}${size}`.replace(/\s+/g, ' ').trim()
}
