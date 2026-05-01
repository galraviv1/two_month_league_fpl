// Shared FPL proxy helper used by serverless functions.
// - Sends a real User-Agent so FPL/Cloudflare is less likely to challenge us.
// - Validates 2xx + JSON content-type before parsing (no more silent 500s).
// - Retries up to 2 extra times (3 attempts total) with 250ms / 500ms backoff.
// - On final failure, forwards FPL's actual status code and a body preview.

const DEFAULT_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (compatible; FplTwoMonthLeague/1.0; +https://two-month-league-fpl.vercel.app)',
  'Accept': 'application/json',
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function fetchFplJson(upstreamUrl) {
  const backoffsMs = [0, 250, 500]
  let lastErr = null
  let lastStatus = null
  let lastBodyPreview = ''

  for (let attempt = 0; attempt < backoffsMs.length; attempt++) {
    if (backoffsMs[attempt] > 0) await sleep(backoffsMs[attempt])
    try {
      const res = await fetch(upstreamUrl, { headers: DEFAULT_HEADERS })
      lastStatus = res.status
      const ct = res.headers.get('content-type') || ''
      if (!res.ok || !ct.includes('application/json')) {
        const text = await res.text().catch(() => '')
        lastBodyPreview = text.slice(0, 200)
        lastErr = new Error(`FPL ${res.status} (ct=${ct || 'none'})`)
        continue
      }
      const data = await res.json()
      return { ok: true, data }
    } catch (err) {
      lastErr = err
    }
  }

  return {
    ok: false,
    status: lastStatus && lastStatus >= 400 ? lastStatus : 502,
    error: lastErr ? lastErr.message : 'Unknown FPL fetch error',
    upstreamPreview: lastBodyPreview,
  }
}

export function setProxyHeaders(res, { live = false } = {}) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET')
  res.setHeader(
    'Cache-Control',
    live
      ? 'no-cache, no-store, must-revalidate'
      : 's-maxage=300, stale-while-revalidate'
  )
}
