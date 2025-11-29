import { useState, useEffect } from 'react'

// API endpoints - using serverless functions for production, proxy for development
const BOOTSTRAP_API = '/api/bootstrap-static'
const LEAGUE_API = '/api/leagues-classic/286461/standings'
const MANAGER_HISTORY_API = '/api/entry/{team_id}/history'
const LIVE_GAMEWEEK_API = '/api/event/{event_id}/live'
const MANAGER_PICKS_API = '/api/entry/{team_id}/event/{event_id}/picks'

function App() {
  // Define the 5 two-month periods
  const periods = [
    { id: 'aug-sep', name: 'August + September', months: [8, 9] },
    { id: 'oct-nov', name: 'October + November', months: [10, 11] },
    { id: 'dec-jan', name: 'December + January', months: [12, 1] },
    { id: 'feb-mar', name: 'February + March', months: [2, 3] },
    { id: 'apr-may', name: 'April + May', months: [4, 5] }
  ]

  // Helper function to determine current period based on today's date
  const getCurrentPeriodId = () => {
    const currentMonth = new Date().getMonth() + 1 // 1-12
    
    if (currentMonth === 8 || currentMonth === 9) return 'aug-sep'
    if (currentMonth === 10 || currentMonth === 11) return 'oct-nov'
    if (currentMonth === 12 || currentMonth === 1) return 'dec-jan'
    if (currentMonth === 2 || currentMonth === 3) return 'feb-mar'
    if (currentMonth === 4 || currentMonth === 5) return 'apr-may'
    
    // Default fallback to August + September (start of season)
    return 'aug-sep'
  }

  // State management
  const [selectedPeriod, setSelectedPeriod] = useState(getCurrentPeriodId())
  const [standings, setStandings] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [allData, setAllData] = useState(null) // Store all fetched data to avoid refetching
  const [isLiveGameweek, setIsLiveGameweek] = useState(false)
  const [liveGameweekId, setLiveGameweekId] = useState(null)
  const [refreshingLive, setRefreshingLive] = useState(false)

  // Fetch all data on component mount
  useEffect(() => {
    fetchAllData()
  }, [])

  // Recalculate standings when period changes
  useEffect(() => {
    if (allData) {
      calculateStandings(selectedPeriod)
    }
  }, [selectedPeriod, allData, liveGameweekId])

  // Auto-refresh live data every 2 minutes when live gameweek is active
  useEffect(() => {
    let intervalId = null
    
    if (isLiveGameweek && allData) {
      // Refresh every 2 minutes (120000ms)
      intervalId = setInterval(() => {
        setRefreshingLive(true)
        calculateStandings(selectedPeriod)
      }, 2 * 60 * 1000)
    }
    
    return () => {
      if (intervalId) clearInterval(intervalId)
    }
  }, [isLiveGameweek, selectedPeriod, allData])

  // Fetch bootstrap data to map gameweeks to dates
  const fetchBootstrapData = async () => {
    try {
      const response = await fetch(BOOTSTRAP_API)
      if (!response.ok) throw new Error('Failed to fetch bootstrap data')
      const data = await response.json()
      // events array contains all gameweeks with deadline_time
      return data.events
    } catch (err) {
      throw new Error(`Bootstrap API error: ${err.message}`)
    }
  }

  // Fetch league members
  const fetchLeagueMembers = async () => {
    try {
      const response = await fetch(LEAGUE_API)
      if (!response.ok) throw new Error('Failed to fetch league data')
      const data = await response.json()
      // results array contains all managers
      return data.standings.results
    } catch (err) {
      throw new Error(`League API error: ${err.message}`)
    }
  }

  // Fetch individual manager's gameweek history
  const fetchManagerHistory = async (teamId) => {
    try {
      const url = MANAGER_HISTORY_API.replace('{team_id}', teamId)
      const response = await fetch(url)
      if (!response.ok) throw new Error(`Failed to fetch history for team ${teamId}`)
      const data = await response.json()
      // current array contains gameweek-by-gameweek points
      return data.current
    } catch (err) {
      throw new Error(`Manager history API error: ${err.message}`)
    }
  }

  // Detect current live gameweek from bootstrap data
  const getCurrentLiveGameweek = (gameweeks) => {
    if (!gameweeks || gameweeks.length === 0) return null
    const liveGW = gameweeks.find(gw => gw.is_current === true && gw.finished === false)
    return liveGW ? liveGW.id : null
  }

  // Check if a gameweek belongs to the selected period
  const isGameweekInPeriod = (gameweekId, periodId, periodMapping) => {
    const gameweeksInPeriod = periodMapping[periodId] || []
    return gameweeksInPeriod.includes(gameweekId)
  }

  // Fetch live gameweek data (all players' live stats)
  const fetchLiveGameweekData = async (gameweekId) => {
    try {
      const url = LIVE_GAMEWEEK_API.replace('{event_id}', gameweekId)
      const response = await fetch(url)
      if (!response.ok) throw new Error('Failed to fetch live gameweek data')
      const data = await response.json()
      // Returns array of elements with player stats: { id, stats: { total_points, ... } }
      return data.elements
    } catch (err) {
      throw new Error(`Live gameweek API error: ${err.message}`)
    }
  }

  // Fetch manager's picks for a specific gameweek
  const fetchManagerPicks = async (teamId, gameweekId) => {
    try {
      const url = MANAGER_PICKS_API
        .replace('{team_id}', teamId)
        .replace('{event_id}', gameweekId)
      const response = await fetch(url)
      if (!response.ok) throw new Error(`Failed to fetch picks for team ${teamId}`)
      const data = await response.json()
      // Returns: { picks: [{ element: playerId, is_captain: bool, is_vice_captain: bool, multiplier: number }] }
      return data.picks
    } catch (err) {
      throw new Error(`Manager picks API error: ${err.message}`)
    }
  }

  // Calculate live points for a manager from their picks and live player data
  const calculateManagerLivePoints = (picks, livePlayerData) => {
    if (!picks || !livePlayerData) return 0
    
    // Create a map of player ID to live points
    const playerPointsMap = {}
    livePlayerData.forEach(player => {
      playerPointsMap[player.id] = player.stats.total_points || 0
    })
    
    // Calculate total points considering captain, bench, etc.
    let totalPoints = 0
    picks.forEach(pick => {
      // multiplier is 0 for bench players, 1 for regular, 2 for captain, 3 for triple captain
      if (pick.multiplier > 0) {
        const playerPoints = playerPointsMap[pick.element] || 0
        totalPoints += playerPoints * pick.multiplier
      }
    })
    
    return totalPoints
  }

  // Map gameweeks to 2-month periods based on deadline dates
  const mapGameweeksToPeriods = (gameweeks) => {
    const periodMapping = {}
    
    periods.forEach(period => {
      periodMapping[period.id] = []
    })

    gameweeks.forEach(gameweek => {
      // Parse deadline_time to get the month
      const deadline = new Date(gameweek.deadline_time)
      const month = deadline.getMonth() + 1 // getMonth() returns 0-11, we need 1-12

      // Find which period this gameweek belongs to
      periods.forEach(period => {
        if (period.months.includes(month)) {
          periodMapping[period.id].push(gameweek.id)
        }
      })
    })

    return periodMapping
  }

  // Fetch all data once
  const fetchAllData = async () => {
    setLoading(true)
    setError(null)

    try {
      // Fetch bootstrap data to get gameweek-to-date mappings
      const gameweeks = await fetchBootstrapData()
      const periodMapping = mapGameweeksToPeriods(gameweeks)

      // Detect live gameweek
      const currentLiveGWId = getCurrentLiveGameweek(gameweeks)
      setLiveGameweekId(currentLiveGWId)
      if (currentLiveGWId) {
        console.log(`Live gameweek detected: GW${currentLiveGWId}`)
      } else {
        console.log('No live gameweek currently active')
      }

      // Fetch league members
      const members = await fetchLeagueMembers()

      // Fetch history for all managers (this may take a while)
      const managersWithHistory = await Promise.all(
        members.map(async (member) => {
          try {
            const history = await fetchManagerHistory(member.entry)
            return {
              teamId: member.entry,
              managerName: member.player_name,
              teamName: member.entry_name,
              history: history
            }
          } catch (err) {
            console.error(`Failed to fetch history for ${member.player_name}:`, err)
            return {
              teamId: member.entry,
              managerName: member.player_name,
              teamName: member.entry_name,
              history: []
            }
          }
        })
      )

      // Store all data
      setAllData({
        periodMapping,
        managers: managersWithHistory,
        gameweeks: gameweeks
      })

    } catch (err) {
      setError(err.message)
      setLoading(false)
    }
  }

  // Calculate standings for the selected period
  const calculateStandings = async (periodId) => {
    if (!allData) return

    const { periodMapping, managers, gameweeks } = allData
    const gameweeksInPeriod = periodMapping[periodId] || []

    // Check if selected period contains the live gameweek
    const isLiveGWInPeriod = liveGameweekId && isGameweekInPeriod(liveGameweekId, periodId, periodMapping)
    setIsLiveGameweek(isLiveGWInPeriod)
    
    if (liveGameweekId) {
      console.log(`Live GW${liveGameweekId} is ${isLiveGWInPeriod ? 'in' : 'not in'} selected period: ${periodId}`)
    }

    let livePlayerData = null
    if (isLiveGWInPeriod) {
      try {
        console.log(`Fetching live data for GW${liveGameweekId}...`)
        livePlayerData = await fetchLiveGameweekData(liveGameweekId)
        console.log(`Successfully fetched live data for ${livePlayerData?.length || 0} players`)
      } catch (err) {
        console.error('Failed to fetch live gameweek data:', err)
        // Fall back to historical data only
        setIsLiveGameweek(false)
      }
    }

    // Calculate points for each manager
    const standingsPromises = managers.map(async (manager) => {
      // Sum historical points (all completed GWs in period, excluding live GW)
      const historicalPoints = manager.history
        .filter(gw => {
          // Include completed GWs in the period, but exclude the live GW
          return gameweeksInPeriod.includes(gw.event) && 
                 (!liveGameweekId || gw.event !== liveGameweekId)
        })
        .reduce((sum, gw) => sum + gw.points, 0)
      
      // Add live points if applicable
      let livePoints = 0
      let hasLiveData = false
      if (isLiveGWInPeriod && livePlayerData) {
        try {
          const picks = await fetchManagerPicks(manager.teamId, liveGameweekId)
          livePoints = calculateManagerLivePoints(picks, livePlayerData)
          hasLiveData = true // Successfully fetched live data
        } catch (err) {
          console.error(`Failed to get live points for ${manager.managerName}:`, err)
          // Use historical points only if live fetch fails
        }
      }
      
      return {
        managerName: manager.managerName,
        teamName: manager.teamName,
        points: historicalPoints + livePoints,
        hasLiveData: hasLiveData
      }
    })
    
    const standings = await Promise.all(standingsPromises)

    // Sort by points descending
    standings.sort((a, b) => b.points - a.points)

    // Add rank
    const rankedStandings = standings.map((entry, index) => ({
      ...entry,
      rank: index + 1
    }))

    setStandings(rankedStandings)
    setLoading(false)
    setRefreshingLive(false)
  }

  // Handle period change
  const handlePeriodChange = (e) => {
    setSelectedPeriod(e.target.value)
  }

  // Handle manual refresh of live data
  const handleManualRefresh = () => {
    if (isLiveGameweek && allData) {
      setRefreshingLive(true)
      calculateStandings(selectedPeriod)
    }
  }

  // Get current period name
  const getCurrentPeriodName = () => {
    const period = periods.find(p => p.id === selectedPeriod)
    return period ? period.name : ''
  }

  return (
    <div className="min-h-screen bg-gray-50 py-4 sm:py-8 px-3 sm:px-4">
      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <div className="text-center mb-6 sm:mb-8">
          <h1 className="text-2xl sm:text-3xl md:text-4xl font-bold text-gray-900 mb-2">
            FPL 2-Month League Standings
          </h1>
          <p className="text-sm sm:text-base text-gray-600">League ID: 286461 ••• Season 2025/26</p>
        </div>

        {/* Period Selector */}
        <div className="bg-white rounded-lg shadow-md p-4 sm:p-6 mb-4 sm:mb-6">
          <div className="flex items-center justify-between mb-3">
            <label htmlFor="period-select" className="block text-base sm:text-lg font-semibold text-gray-700">
              Select 2-Month Period:
            </label>
            {isLiveGameweek && (
              <span className="inline-flex items-center px-2 sm:px-3 py-1 text-xs sm:text-sm font-semibold text-red-600 bg-red-50 rounded-full">
                🔴 LIVE
              </span>
            )}
          </div>
          <div className="flex gap-2 sm:gap-3">
            <select
              id="period-select"
              value={selectedPeriod}
              onChange={handlePeriodChange}
              disabled={loading && !allData}
              className="flex-1 px-3 sm:px-4 py-2 sm:py-3 text-base sm:text-lg border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:bg-gray-100 disabled:cursor-not-allowed"
            >
              {periods.map(period => (
                <option key={period.id} value={period.id}>
                  {period.name}
                </option>
              ))}
            </select>
            {isLiveGameweek && (
              <button
                onClick={handleManualRefresh}
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
        </div>

        {/* Loading State */}
        {loading && (
          <div className="bg-white rounded-lg shadow-md p-12 text-center">
            <div className="inline-block animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mb-4"></div>
            <p className="text-gray-600 text-lg">Loading league data...</p>
            <p className="text-gray-500 text-sm mt-2">This may take a moment as we fetch data for all managers</p>
          </div>
        )}

        {/* Error State */}
        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-6">
            <h3 className="text-red-800 font-semibold text-lg mb-2">Error Loading Data</h3>
            <p className="text-red-600">{error}</p>
            <button
              onClick={fetchAllData}
              className="mt-4 px-6 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors"
            >
              Retry
            </button>
          </div>
        )}

        {/* Standings Table */}
        {!loading && !error && standings.length > 0 && (
          <div className="bg-white rounded-lg shadow-md overflow-hidden">
            <div className="bg-gradient-to-r from-blue-600 to-purple-600 px-4 sm:px-6 py-3 sm:py-4">
              <h2 className="text-xl sm:text-2xl font-bold text-white">
                {getCurrentPeriodName()} Standings{isLiveGameweek && ' 🔴 LIVE'}
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
                        <span className={`inline-flex items-center justify-center w-7 h-7 sm:w-8 sm:h-8 rounded-full font-bold text-sm ${
                          entry.rank === 1 ? 'bg-yellow-100 text-yellow-800' :
                          entry.rank === 2 ? 'bg-gray-100 text-gray-800' :
                          entry.rank === 3 ? 'bg-orange-100 text-orange-800' :
                          'bg-blue-50 text-blue-800'
                        }`}>
                          {entry.rank}
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
                        <span className="text-base sm:text-lg font-bold text-gray-900">
                          {entry.points}{entry.hasLiveData && ' 🔴'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* No Data State */}
        {!loading && !error && standings.length === 0 && allData && (
          <div className="bg-white rounded-lg shadow-md p-12 text-center">
            <p className="text-gray-600 text-lg">No data available for this period</p>
          </div>
        )}
      </div>
    </div>
  )
}

export default App

