import { fetchFplJson, setProxyHeaders } from '../../../../_lib/proxyFpl.js'

export default async function handler(req, res) {
  const { teamId, eventId } = req.query

  const result = await fetchFplJson(
    `https://fantasy.premierleague.com/api/entry/${teamId}/event/${eventId}/picks/`
  )

  setProxyHeaders(res, { live: true })

  if (!result.ok) {
    return res.status(result.status).json({
      error: 'Failed to fetch manager picks',
      detail: result.error,
      upstreamPreview: result.upstreamPreview,
    })
  }

  return res.status(200).json(result.data)
}
