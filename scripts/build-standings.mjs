// Precomputes the entire 2-month-league dataset into a single static file at
// public/data/standings.json, which the deployed app fetches once. This moves
// the heavy ~30-manager fan-out off the browser / Vercel egress (which FPL's
// WAF blocks for the /picks/ endpoint) and onto this GitHub Actions cron, which
// runs from a residential-style GitHub IP that FPL serves normally.
//
// What it writes per manager:
//   - gwPoints:   { [gw]: netPoints }  (points minus transfer-hit cost)
//   - livePicks:  the frozen picks for the current live GW (element+multiplier)
//   - liveHitCost the transfer-hit cost applied in the live GW
// The browser combines gwPoints (completed GWs) with a single /event/{gw}/live
// call (live player points x multiplier) to show near-real-time live scores.
//
// Run locally:  node scripts/build-standings.mjs
// Run in CI:    .github/workflows/build-standings.yml (every 15 min)

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { fetchFplJson } from '../api/_lib/proxyFpl.js'
import { LEAGUE_ID, SEASON_LABEL, PERIODS, MONTH_NAME_TO_NUMBER } from '../config.mjs'

const CONCURRENCY = 3
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUTPUT_PATH = resolve(REPO_ROOT, 'public/data/standings.json')

const FPL = {
  bootstrap: 'https://fantasy.premierleague.com/api/bootstrap-static/',
  standings: (leagueId, pageStandings, pageNew) =>
    `https://fantasy.premierleague.com/api/leagues-classic/${leagueId}/standings/` +
    `?page_standings=${pageStandings}&page_new_entries=${pageNew}`,
  history: (teamId) =>
    `https://fantasy.premierleague.com/api/entry/${teamId}/history/`,
  picks: (teamId, eventId) =>
    `https://fantasy.premierleague.com/api/entry/${teamId}/event/${eventId}/picks/`,
}

const log = (...args) => console.log('[build-standings]', ...args)

const mapWithConcurrency = async (items, limit, fn) => {
  const results = new Array(items.length)
  let nextIndex = 0
  const workers = Array(Math.min(limit, items.length))
    .fill(0)
    .map(async () => {
      while (true) {
        const i = nextIndex++
        if (i >= items.length) return
        results[i] = await fn(items[i], i)
      }
    })
  await Promise.all(workers)
  return results
}

// Build a { gameweek -> calendarMonth } map from bootstrap `phases`, which is
// FPL's own authoritative month grouping. Falls back to deadline_time parsing
// (UTC) if phases are unavailable.
function buildGameweekMonthMap(bootstrap) {
  const map = {}
  const phases = bootstrap.phases || []
  const monthPhases = phases.filter((p) => p.name !== 'Overall')

  if (monthPhases.length > 0) {
    for (const phase of monthPhases) {
      const month = MONTH_NAME_TO_NUMBER[phase.name]
      if (!month) continue
      for (let gw = phase.start_event; gw <= phase.stop_event; gw++) {
        map[gw] = month
      }
    }
    return map
  }

  for (const ev of bootstrap.events || []) {
    map[ev.id] = new Date(ev.deadline_time).getUTCMonth() + 1
  }
  return map
}

function buildPeriods(bootstrap) {
  const gwMonth = buildGameweekMonthMap(bootstrap)
  return PERIODS.map((period) => {
    const gameweeks = Object.entries(gwMonth)
      .filter(([, month]) => period.months.includes(month))
      .map(([gw]) => Number(gw))
      .sort((a, b) => a - b)
    return { id: period.id, name: period.name, gameweeks }
  })
}

// Union of `standings.results` (existing managers) and `new_entries.results`
// (managers who joined pre-season, before any GW has been scored), deduped by
// entry id, following pagination on both lists.
async function fetchAllMembers(leagueId) {
  const byEntry = new Map()
  let pageStandings = 1
  let pageNew = 1
  let moreStandings = true
  let moreNew = true
  let leagueName = null
  let guard = 0

  while ((moreStandings || moreNew) && guard < 50) {
    guard++
    const res = await fetchFplJson(FPL.standings(leagueId, pageStandings, pageNew))
    if (!res.ok) {
      throw new Error(`standings fetch failed: status=${res.status} ${res.error}`)
    }
    const data = res.data
    leagueName = data.league?.name ?? leagueName

    for (const r of data.standings?.results || []) {
      byEntry.set(r.entry, {
        entry: r.entry,
        managerName: r.player_name,
        teamName: r.entry_name,
      })
    }
    for (const r of data.new_entries?.results || []) {
      if (byEntry.has(r.entry)) continue
      const name = [r.player_first_name, r.player_last_name].filter(Boolean).join(' ').trim()
      byEntry.set(r.entry, {
        entry: r.entry,
        managerName: name || r.entry_name,
        teamName: r.entry_name,
      })
    }

    moreStandings = Boolean(data.standings?.has_next)
    moreNew = Boolean(data.new_entries?.has_next)
    if (moreStandings) pageStandings++
    if (moreNew) pageNew++
  }

  return { members: [...byEntry.values()], leagueName }
}

// Reads history and returns net points per gameweek plus a diagnostic that
// tells us empirically whether history `points` is gross or net of transfer
// hits (unverifiable pre-season; resolves the first time a GW is scored).
async function fetchManagerGwPoints(teamId) {
  const res = await fetchFplJson(FPL.history(teamId))
  if (!res.ok) {
    return { ok: false, status: res.status, error: res.error }
  }
  const rows = res.data?.current || []
  const gwPoints = {}
  let sumGross = 0
  let sumNet = 0
  let lastTotal = 0
  for (const row of rows) {
    const cost = row.event_transfers_cost || 0
    const net = (row.points || 0) - cost
    gwPoints[row.event] = net
    sumGross += row.points || 0
    sumNet += net
    lastTotal = row.total_points ?? lastTotal
  }
  return { ok: true, gwPoints, diag: { sumGross, sumNet, lastTotal, rows: rows.length } }
}

async function main() {
  log(`Season ${SEASON_LABEL}, league ${LEAGUE_ID}.`)

  log('Fetching bootstrap-static…')
  const bootstrapRes = await fetchFplJson(FPL.bootstrap)
  if (!bootstrapRes.ok) {
    throw new Error(`bootstrap fetch failed: status=${bootstrapRes.status} ${bootstrapRes.error}`)
  }
  const bootstrap = bootstrapRes.data
  const events = bootstrap.events || []

  const liveEvent = events.find((e) => e.is_current === true && e.finished === false)
  const nextEvent = events.find((e) => e.is_next === true)
  const liveGameweek = liveEvent ? liveEvent.id : null
  const nextGameweek = nextEvent ? nextEvent.id : null
  const nextDeadline = nextEvent ? nextEvent.deadline_time : null
  log(liveGameweek ? `Live gameweek: GW${liveGameweek}` : `No live gameweek. Next: GW${nextGameweek ?? '—'}`)

  const periods = buildPeriods(bootstrap)

  log(`Fetching league members for ${LEAGUE_ID}…`)
  const { members, leagueName } = await fetchAllMembers(LEAGUE_ID)
  if (members.length === 0) {
    throw new Error('league returned 0 members; refusing to overwrite output')
  }
  log(`League "${leagueName}" has ${members.length} members.`)

  // Load prior output so we can reuse already-cached live picks (frozen at the
  // deadline) and fill in any managers whose picks previously failed.
  let prior = null
  if (existsSync(OUTPUT_PATH)) {
    try {
      prior = JSON.parse(await readFile(OUTPUT_PATH, 'utf8'))
    } catch (err) {
      log(`Could not parse existing output (${err.message}); starting fresh.`)
    }
  }
  const priorPicksByEntry = new Map()
  if (prior && prior.liveGameweek === liveGameweek && Array.isArray(prior.managers)) {
    for (const m of prior.managers) {
      if (Array.isArray(m.livePicks) && m.livePicks.length > 0) {
        priorPicksByEntry.set(m.entry, { livePicks: m.livePicks, liveHitCost: m.liveHitCost || 0 })
      }
    }
  }

  log(`Fetching history for ${members.length} managers (concurrency=${CONCURRENCY})…`)
  const managers = await mapWithConcurrency(members, CONCURRENCY, async (member) => {
    const hist = await fetchManagerGwPoints(member.entry)
    return {
      entry: member.entry,
      managerName: member.managerName,
      teamName: member.teamName,
      gwPoints: hist.ok ? hist.gwPoints : {},
      historyFailed: !hist.ok,
      _diag: hist.ok ? hist.diag : null,
      _error: hist.ok ? null : hist.error,
    }
  })

  const historyFailures = managers.filter((m) => m.historyFailed)
  if (historyFailures.length > 0) {
    log(`WARNING: ${historyFailures.length} manager histories failed:`)
    for (const m of historyFailures) log(`  fail: entry=${m.entry} (${m.managerName}) ${m._error}`)
  }

  // Gross-vs-net diagnostic: whichever running sum equals total_points is the
  // truth. Report any manager whose stored net sum disagrees with total_points.
  const mismatches = managers.filter(
    (m) => m._diag && m._diag.rows > 0 && m._diag.sumNet !== m._diag.lastTotal
  )
  if (mismatches.length > 0) {
    const example = mismatches[0]._diag
    log(
      `NOTE: net-sum != total_points for ${mismatches.length} managers ` +
        `(e.g. gross=${example.sumGross} net=${example.sumNet} total=${example.lastTotal}). ` +
        `If gross==total for these, history 'points' already excludes hits and the ` +
        `subtraction in fetchManagerGwPoints should be removed.`
    )
  } else if (managers.some((m) => m._diag && m._diag.rows > 0)) {
    log('Self-check OK: net-of-hits sum matches total_points for all scored managers.')
  }

  // Live picks: only needed while a GW is in progress. Fetch only for managers
  // we don't already have cached picks for.
  let livePicksFetched = 0
  let livePicksFailed = 0
  if (liveGameweek) {
    const needPicks = managers.filter((m) => !priorPicksByEntry.has(m.entry))
    log(`Fetching live picks for ${needPicks.length} of ${managers.length} managers (rest cached)…`)
    await mapWithConcurrency(needPicks, CONCURRENCY, async (m) => {
      const res = await fetchFplJson(FPL.picks(m.entry, liveGameweek))
      if (!res.ok) {
        livePicksFailed++
        return
      }
      const livePicks = (res.data?.picks || []).map((p) => ({
        element: p.element,
        multiplier: p.multiplier,
      }))
      const liveHitCost = res.data?.entry_history?.event_transfers_cost || 0
      priorPicksByEntry.set(m.entry, { livePicks, liveHitCost })
      livePicksFetched++
    })
    log(`Live picks: ${livePicksFetched} fetched, ${livePicksFailed} failed, ` +
      `${priorPicksByEntry.size}/${managers.length} total cached for GW${liveGameweek}.`)
  }

  // Sort by entry id so the output is deterministic; FPL returns new_entries in
  // an unstable order, and without this the file would churn (and the cron would
  // commit) on every run even when nothing meaningful changed.
  const outputManagers = managers
    .slice()
    .sort((a, b) => a.entry - b.entry)
    .map((m) => {
      const cached = priorPicksByEntry.get(m.entry)
      return {
        entry: m.entry,
        managerName: m.managerName,
        teamName: m.teamName,
        gwPoints: m.gwPoints,
        historyFailed: m.historyFailed,
        livePicks: cached ? cached.livePicks : [],
        liveHitCost: cached ? cached.liveHitCost : 0,
      }
    })

  const output = {
    season: SEASON_LABEL,
    leagueId: LEAGUE_ID,
    leagueName: leagueName || '',
    dataUpdatedAt: new Date().toISOString(),
    liveGameweek,
    nextGameweek,
    nextDeadline,
    periods,
    managers: outputManagers,
  }

  // Write only if something other than the timestamp changed, so the cron stays
  // quiet (no empty commits) between gameweeks.
  const stripTs = (obj) => JSON.stringify({ ...obj, dataUpdatedAt: null })
  if (prior && stripTs(prior) === stripTs(output)) {
    log('No content changes since last run; leaving output untouched.')
    return
  }

  await mkdir(dirname(OUTPUT_PATH), { recursive: true })
  await writeFile(OUTPUT_PATH, JSON.stringify(output, null, 2) + '\n', 'utf8')
  log(`Wrote ${OUTPUT_PATH} (${outputManagers.length} managers, ` +
    `live=${liveGameweek ?? 'none'}).`)
}

main().catch((err) => {
  console.error('[build-standings] FAILED:', err.message)
  process.exit(1)
})
