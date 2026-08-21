import { useState, useEffect, useCallback, useMemo } from 'react'

// The heavy data (all managers, all gameweeks, frozen live picks) is precomputed
// by scripts/build-standings.mjs and served as a single static file. The browser
// never fans out to FPL. The only live call is one /event/{gw}/live request that
// returns every player's current points, which we combine with the frozen picks.
const STANDINGS_URL = '/data/standings.json'
const LIVE_GAMEWEEK_API = '/api/event/{event_id}/live'
const LIVE_REFRESH_MS = 2 * 60 * 1000

const fetchLivePlayerPoints = async (gameweekId) => {
  const url = LIVE_GAMEWEEK_API.replace('{event_id}', gameweekId)
  const res = await fetch(url, { cache: 'no-store' })
  if (!res.ok) throw new Error('Failed to fetch live gameweek data')
  const data = await res.json()
  const map = {}
  for (const el of data.elements || []) {
    map[el.id] = el.stats?.total_points || 0
  }
  return map
}

const formatUpdatedAgo = (iso) => {
  if (!iso) return null
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000))
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  return `${hrs}h ${mins % 60}m ago`
}

function App() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [selectedPeriod, setSelectedPeriod] = useState(null)
  const [livePoints, setLivePoints] = useState(null) // { [element]: points }
  const [refreshingLive, setRefreshingLive] = useState(false)

  const loadStandings = useCallback(async () => {
    const res = await fetch(STANDINGS_URL, { cache: 'no-store' })
    if (!res.ok) throw new Error('Failed to load standings data')
    return res.json()
  }, [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        setLoading(true)
        const json = await loadStandings()
        if (cancelled) return
        setData(json)
        // Auto-select the period containing the live GW, else the next GW, else first.
        const target = json.liveGameweek || json.nextGameweek
        const period =
          json.periods.find((p) => target && p.gameweeks.includes(target)) || json.periods[0]
        setSelectedPeriod(period?.id ?? null)
      } catch (err) {
        if (!cancelled) setError(err.message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [loadStandings])

  const liveGameweek = data?.liveGameweek ?? null
  const currentPeriod = useMemo(
    () => data?.periods.find((p) => p.id === selectedPeriod) ?? null,
    [data, selectedPeriod]
  )
  const isLiveInPeriod = Boolean(
    liveGameweek && currentPeriod && currentPeriod.gameweeks.includes(liveGameweek)
  )

  // Whether any gameweek has been scored yet (distinguishes pre-season from a
  // real all-zero table).
  const seasonStarted = useMemo(() => {
    if (!data) return false
    if (data.liveGameweek) return true
    return data.managers.some((m) => Object.keys(m.gwPoints || {}).length > 0)
  }, [data])

  // Fetch live player points whenever we're viewing a period with a live GW.
  const refreshLive = useCallback(async () => {
    if (!liveGameweek) return
    setRefreshingLive(true)
    try {
      // Re-pull standings too, so newly-cached picks (cron fill-in) appear.
      const [json, points] = await Promise.all([
        loadStandings().catch(() => null),
        fetchLivePlayerPoints(liveGameweek),
      ])
      if (json) setData(json)
      setLivePoints(points)
    } catch (err) {
      console.error('Live refresh failed:', err)
    } finally {
      setRefreshingLive(false)
    }
  }, [liveGameweek, loadStandings])

  useEffect(() => {
    if (isLiveInPeriod) {
      refreshLive()
    } else {
      setLivePoints(null)
    }
  }, [isLiveInPeriod, refreshLive])

  useEffect(() => {
    if (!isLiveInPeriod) return
    const id = setInterval(refreshLive, LIVE_REFRESH_MS)
    return () => clearInterval(id)
  }, [isLiveInPeriod, refreshLive])

  const standings = useMemo(() => {
    if (!data || !currentPeriod) return []
    const periodGWs = currentPeriod.gameweeks

    const rows = data.managers.map((m) => {
      const gwPoints = m.gwPoints || {}
      // Sum completed GWs in this period, excluding the in-progress live GW
      // (its points come from the live calculation instead).
      const historical = periodGWs.reduce((sum, gw) => {
        if (isLiveInPeriod && gw === liveGameweek) return sum
        return sum + (gwPoints[gw] || 0)
      }, 0)

      let live = 0
      let hasLiveData = false
      let livePartial = false
      if (isLiveInPeriod) {
        if (Array.isArray(m.livePicks) && m.livePicks.length > 0 && livePoints) {
          live = m.livePicks.reduce((sum, pick) => {
            if (pick.multiplier > 0) return sum + (livePoints[pick.element] || 0) * pick.multiplier
            return sum
          }, 0)
          live -= m.liveHitCost || 0
          hasLiveData = true
        } else {
          // Cron hasn't captured this manager's picks yet — show historical only
          // and badge it, rather than rendering a misleadingly complete score.
          livePartial = true
        }
      }

      return {
        managerName: m.managerName,
        teamName: m.teamName,
        points: historical + live,
        historyFailed: Boolean(m.historyFailed),
        hasLiveData,
        livePartial,
      }
    })

    rows.sort((a, b) => {
      if (a.historyFailed !== b.historyFailed) return a.historyFailed ? 1 : -1
      return b.points - a.points
    })

    // Tie-aware ranking: equal point totals share a rank.
    let lastPoints = null
    let lastRank = 0
    return rows.map((row, i) => {
      let rank
      if (row.historyFailed) {
        rank = null
      } else if (row.points === lastPoints) {
        rank = lastRank
      } else {
        rank = i + 1
        lastRank = rank
        lastPoints = row.points
      }
      return { ...row, rank }
    })
  }, [data, currentPeriod, isLiveInPeriod, liveGameweek, livePoints])

  const updatedAgo = formatUpdatedAgo(data?.dataUpdatedAt)
  const isStale =
    isLiveInPeriod &&
    data?.dataUpdatedAt &&
    Date.now() - new Date(data.dataUpdatedAt).getTime() > 30 * 60 * 1000

  return (
    <div className="min-h-screen bg-gray-50 py-4 sm:py-8 px-3 sm:px-4">
      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <div className="text-center mb-6 sm:mb-8">
          <h1 className="text-2xl sm:text-3xl md:text-4xl font-bold text-gray-900 mb-2">
            FPL 2-Month League Standings
          </h1>
          <p className="text-sm sm:text-base text-gray-600">
            {data?.leagueName ? `${data.leagueName} ` : ''}
            {data ? `••• League ${data.leagueId} ••• Season ${data.season}` : ''}
          </p>
        </div>

        {/* Period Selector */}
        {data && (
          <div className="bg-white rounded-lg shadow-md p-4 sm:p-6 mb-4 sm:mb-6">
            <div className="flex items-center justify-between mb-3">
              <label
                htmlFor="period-select"
                className="block text-base sm:text-lg font-semibold text-gray-700"
              >
                Select 2-Month Period:
              </label>
              {isLiveInPeriod && (
                <span className="inline-flex items-center px-2 sm:px-3 py-1 text-xs sm:text-sm font-semibold text-red-600 bg-red-50 rounded-full">
                  🔴 LIVE
                </span>
              )}
            </div>
            <div className="flex gap-2 sm:gap-3">
              <select
                id="period-select"
                value={selectedPeriod ?? ''}
                onChange={(e) => setSelectedPeriod(e.target.value)}
                className="flex-1 px-3 sm:px-4 py-2 sm:py-3 text-base sm:text-lg border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              >
                {data.periods.map((period) => {
                  const gws = period.gameweeks
                  const range = gws.length ? ` (GW${gws[0]}-${gws[gws.length - 1]})` : ''
                  return (
                    <option key={period.id} value={period.id}>
                      {period.name}
                      {range}
                    </option>
                  )
                })}
              </select>
              {isLiveInPeriod && (
                <button
                  onClick={refreshLive}
                  disabled={refreshingLive}
                  className="px-3 sm:px-4 py-2 sm:py-3 text-sm sm:text-base font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:bg-blue-400 disabled:cursor-not-allowed transition-colors flex items-center gap-2"
                >
                  {refreshingLive ? (
                    <>
                      <div className="inline-block animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
                      <span className="hidden sm:inline">Refreshing...</span>
                    </>
                  ) : (
                    <>
                      <span>🔄</span>
                      <span className="hidden sm:inline">Refresh</span>
                    </>
                  )}
                </button>
              )}
            </div>
            {updatedAgo && (
              <p className="mt-3 text-xs text-gray-500">
                Data updated {updatedAgo}
                {isStale && (
                  <span className="ml-2 text-orange-600 font-medium">
                    ⚠ live data may be stale
                  </span>
                )}
              </p>
            )}
          </div>
        )}

        {/* Loading State */}
        {loading && (
          <div className="bg-white rounded-lg shadow-md p-12 text-center">
            <div className="inline-block animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mb-4"></div>
            <p className="text-gray-600 text-lg">Loading league data...</p>
          </div>
        )}

        {/* Error State */}
        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-6">
            <h3 className="text-red-800 font-semibold text-lg mb-2">Error Loading Data</h3>
            <p className="text-red-600">{error}</p>
            <button
              onClick={() => window.location.reload()}
              className="mt-4 px-6 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors"
            >
              Retry
            </button>
          </div>
        )}

        {/* Pre-season State */}
        {!loading && !error && data && !seasonStarted && (
          <div className="bg-white rounded-lg shadow-md p-8 sm:p-12 text-center">
            <div className="text-4xl mb-3">⚽</div>
            <p className="text-gray-800 text-lg font-semibold mb-2">
              The {data.season} season hasn't kicked off yet
            </p>
            <p className="text-gray-600 text-sm mb-4">
              {data.managers.length} managers are signed up. Standings will appear once GW
              {data.nextGameweek} is scored.
            </p>
            {data.nextDeadline && (
              <p className="text-gray-500 text-sm">
                First deadline:{' '}
                {new Date(data.nextDeadline).toLocaleString(undefined, {
                  weekday: 'short',
                  day: 'numeric',
                  month: 'short',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </p>
            )}
          </div>
        )}

        {/* Standings Table */}
        {!loading && !error && data && seasonStarted && currentPeriod && (
          <div className="bg-white rounded-lg shadow-md overflow-hidden">
            <div className="bg-gradient-to-r from-blue-600 to-purple-600 px-4 sm:px-6 py-3 sm:py-4">
              <h2 className="text-xl sm:text-2xl font-bold text-white">
                {currentPeriod.name} Standings{isLiveInPeriod && ' 🔴 LIVE'}
              </h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="px-2 sm:px-4 py-3 text-left text-xs sm:text-sm font-semibold text-gray-700 uppercase tracking-wider">
                      Rank
                    </th>
                    <th className="px-2 sm:px-4 py-3 text-left text-xs sm:text-sm font-semibold text-gray-700 uppercase tracking-wider">
                      Manager Name
                    </th>
                    <th className="hidden md:table-cell px-2 sm:px-4 py-3 text-left text-xs sm:text-sm font-semibold text-gray-700 uppercase tracking-wider">
                      Team Name
                    </th>
                    <th className="px-2 sm:px-4 py-3 text-right text-xs sm:text-sm font-semibold text-gray-700 uppercase tracking-wider">
                      Points
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200">
                  {standings.map((entry, index) => (
                    <tr
                      key={index}
                      className={`hover:bg-gray-50 transition-colors ${
                        index % 2 === 0 ? 'bg-white' : 'bg-gray-25'
                      }`}
                    >
                      <td className="px-2 sm:px-4 py-3 whitespace-nowrap">
                        <span
                          className={`inline-flex items-center justify-center w-7 h-7 sm:w-8 sm:h-8 rounded-full font-bold text-sm ${
                            entry.rank === 1
                              ? 'bg-yellow-100 text-yellow-800'
                              : entry.rank === 2
                              ? 'bg-gray-100 text-gray-800'
                              : entry.rank === 3
                              ? 'bg-orange-100 text-orange-800'
                              : 'bg-blue-50 text-blue-800'
                          }`}
                        >
                          {entry.rank ?? '—'}
                        </span>
                      </td>
                      <td className="px-2 sm:px-4 py-3 text-gray-900 font-medium text-sm sm:text-base">
                        <div className="flex flex-col">
                          <span>{entry.managerName}</span>
                          <span className="md:hidden text-xs text-gray-500">{entry.teamName}</span>
                        </div>
                      </td>
                      <td className="hidden md:table-cell px-2 sm:px-4 py-3 text-gray-600 text-sm sm:text-base">
                        {entry.teamName}
                      </td>
                      <td className="px-2 sm:px-4 py-3 text-right">
                        {entry.historyFailed ? (
                          <span className="inline-block px-2 py-1 text-xs font-semibold text-yellow-800 bg-yellow-100 rounded">
                            data unavailable
                          </span>
                        ) : (
                          <div className="flex flex-col items-end gap-1">
                            <span className="text-base sm:text-lg font-bold text-gray-900">
                              {entry.points}
                              {entry.hasLiveData && ' 🔴'}
                            </span>
                            {entry.livePartial && (
                              <span className="inline-block px-2 py-0.5 text-[10px] sm:text-xs font-semibold text-orange-800 bg-orange-100 rounded whitespace-nowrap">
                                live GW missing
                              </span>
                            )}
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export default App
