import { fetchFplJson, setProxyHeaders } from '../../_lib/proxyFpl.js'

export default async function handler(req, res) {
  const { teamId } = req.query

  const result = await fetchFplJson(
    `https://fantasy.premierleague.com/api/entry/${teamId}/history/`
  )

  setProxyHeaders(res, { live: false })

  if (!result.ok) {
    return res.status(result.status).json({
      error: 'Failed to fetch manager history',
      detail: result.error,
      upstreamPreview: result.upstreamPreview,
    })
  }

  return res.status(200).json(result.data)
}
