import { useState, useEffect } from 'react'

// API endpoints - using proxy to avoid CORS issues
const BOOTSTRAP_API = '/api/bootstrap-static/'
const LEAGUE_API = '/api/leagues-classic/286461/standings/'
const MANAGER_HISTORY_API = '/api/entry/{team_id}/history/'

function App() {
  // Define the 5 two-month periods
  const periods = [
    { id: 'aug-sep', name: 'August + September', months: [8, 9] },
    { id: 'oct-nov', name: 'October + November', months: [10, 11] },
    { id: 'dec-jan', name: 'December + January', months: [12, 1] },
    { id: 'feb-mar', name: 'February + March', months: [2, 3] },
    { id: 'apr-may', name: 'April + May', months: [4, 5] }
  ]

  // State management
  const [selectedPeriod, setSelectedPeriod] = useState(periods[0].id)
  const [standings, setStandings] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [allData, setAllData] = useState(null) // Store all fetched data to avoid refetching

  // Fetch all data on component mount
  useEffect(() => {
    fetchAllData()
  }, [])

  // Recalculate standings when period changes
  useEffect(() => {
    if (allData) {
      calculateStandings(selectedPeriod)
    }
  }, [selectedPeriod, allData])

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
        managers: managersWithHistory
      })

    } catch (err) {
      setError(err.message)
      setLoading(false)
    }
  }

  // Calculate standings for the selected period
  const calculateStandings = (periodId) => {
    if (!allData) return

    const { periodMapping, managers } = allData
    const gameweeksInPeriod = periodMapping[periodId] || []

    // Calculate total points for each manager in this period
    const standings = managers.map(manager => {
      // Sum points for gameweeks in the selected period
      const totalPoints = manager.history
        .filter(gw => gameweeksInPeriod.includes(gw.event))
        .reduce((sum, gw) => sum + gw.points, 0)

      return {
        managerName: manager.managerName,
        teamName: manager.teamName,
        points: totalPoints
      }
    })

    // Sort by points descending
    standings.sort((a, b) => b.points - a.points)

    // Add rank
    const rankedStandings = standings.map((entry, index) => ({
      ...entry,
      rank: index + 1
    }))

    setStandings(rankedStandings)
    setLoading(false)
  }

  // Handle period change
  const handlePeriodChange = (e) => {
    setSelectedPeriod(e.target.value)
  }

  // Get current period name
  const getCurrentPeriodName = () => {
    const period = periods.find(p => p.id === selectedPeriod)
    return period ? period.name : ''
  }

  return (
    <div className="min-h-screen bg-gray-50 py-8 px-4">
      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <div className="text-center mb-8">
          <h1 className="text-4xl font-bold text-gray-900 mb-2">
            FPL 2-Month League Standings
          </h1>
          <p className="text-gray-600">League ID: 286461 • Season 2024/25</p>
        </div>

        {/* Period Selector */}
        <div className="bg-white rounded-lg shadow-md p-6 mb-6">
          <label htmlFor="period-select" className="block text-lg font-semibold text-gray-700 mb-3">
            Select 2-Month Period:
          </label>
          <select
            id="period-select"
            value={selectedPeriod}
            onChange={handlePeriodChange}
            disabled={loading && !allData}
            className="w-full px-4 py-3 text-lg border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:bg-gray-100 disabled:cursor-not-allowed"
          >
            {periods.map(period => (
              <option key={period.id} value={period.id}>
                {period.name}
              </option>
            ))}
          </select>
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
            <div className="bg-gradient-to-r from-blue-600 to-purple-600 px-6 py-4">
              <h2 className="text-2xl font-bold text-white">
                {getCurrentPeriodName()} Standings
              </h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="px-6 py-4 text-left text-sm font-semibold text-gray-700 uppercase tracking-wider">
                      Rank
                    </th>
                    <th className="px-6 py-4 text-left text-sm font-semibold text-gray-700 uppercase tracking-wider">
                      Manager Name
                    </th>
                    <th className="px-6 py-4 text-left text-sm font-semibold text-gray-700 uppercase tracking-wider">
                      Team Name
                    </th>
                    <th className="px-6 py-4 text-right text-sm font-semibold text-gray-700 uppercase tracking-wider">
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
                      <td className="px-6 py-4 whitespace-nowrap">
                        <span className={`inline-flex items-center justify-center w-8 h-8 rounded-full font-bold ${
                          entry.rank === 1 ? 'bg-yellow-100 text-yellow-800' :
                          entry.rank === 2 ? 'bg-gray-100 text-gray-800' :
                          entry.rank === 3 ? 'bg-orange-100 text-orange-800' :
                          'bg-blue-50 text-blue-800'
                        }`}>
                          {entry.rank}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-gray-900 font-medium">
                        {entry.managerName}
                      </td>
                      <td className="px-6 py-4 text-gray-600">
                        {entry.teamName}
                      </td>
                      <td className="px-6 py-4 text-right">
                        <span className="text-lg font-bold text-gray-900">
                          {entry.points}
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

