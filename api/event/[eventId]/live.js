import { fetchFplJson, setProxyHeaders } from '../../_lib/proxyFpl.js'

// Proxies FPL's live gameweek endpoint (every player's current points). This is
// the single reliable live call the browser makes; unlike /picks/, FPL serves
// /event/{id}/live/ normally to Vercel egress.
export default async function handler(req, res) {
  const { eventId } = req.query

  const result = await fetchFplJson(
    `https://fantasy.premierleague.com/api/event/${eventId}/live/`
  )

  setProxyHeaders(res, { live: true })

  if (!result.ok) {
    return res.status(result.status).json({
      error: 'Failed to fetch live gameweek data',
      detail: result.error,
      upstreamPreview: result.upstreamPreview,
    })
  }

  return res.status(200).json(result.data)
}
