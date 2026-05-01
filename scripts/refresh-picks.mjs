// Fetches the current live gameweek's picks for every manager in the league
// and writes a slim JSON cache to public/data/live-picks.json. The deployed
// app reads this file directly (as a static asset) so it can avoid the FPL
// /picks/ endpoint, which Cloudflare's WAF blocks from Vercel egress IPs.
//
// Run locally:    node scripts/refresh-picks.mjs
// Run in CI:      .github/workflows/refresh-picks.yml does this hourly.

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { fetchFplJson } from '../api/_lib/proxyFpl.js'

const LEAGUE_ID = 286461
const CONCURRENCY = 3
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CACHE_PATH = resolve(REPO_ROOT, 'public/data/live-picks.json')

const FPL = {
  bootstrap: 'https://fantasy.premierleague.com/api/bootstrap-static/',
  standings: (leagueId) =>
    `https://fantasy.premierleague.com/api/leagues-classic/${leagueId}/standings/`,
  picks: (teamId, eventId) =>
    `https://fantasy.premierleague.com/api/entry/${teamId}/event/${eventId}/picks/`,
}

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

const log = (...args) => console.log('[refresh-picks]', ...args)

async function main() {
  log('Fetching bootstrap-static…')
  const bootstrap = await fetchFplJson(FPL.bootstrap)
  if (!bootstrap.ok) {
    throw new Error(`bootstrap fetch failed: status=${bootstrap.status} ${bootstrap.error}`)
  }
  const events = bootstrap.data.events || []
  const liveEvent = events.find((e) => e.is_current === true && e.finished === false)
  if (!liveEvent) {
    log('No live gameweek currently active. Nothing to do.')
    return
  }
  const gameweek = liveEvent.id
  log(`Live gameweek detected: GW${gameweek}`)

  log(`Fetching league standings for league ${LEAGUE_ID}…`)
  const standings = await fetchFplJson(FPL.standings(LEAGUE_ID))
  if (!standings.ok) {
    throw new Error(`standings fetch failed: status=${standings.status} ${standings.error}`)
  }
  const members = standings.data?.standings?.results || []
  if (members.length === 0) {
    throw new Error('league standings returned 0 members; refusing to overwrite cache')
  }
  log(`League has ${members.length} members.`)

  // Load existing cache so we can merge — lets a subsequent run fill in any
  // managers that 403'd previously without losing already-cached ones.
  let existing = null
  if (existsSync(CACHE_PATH)) {
    try {
      existing = JSON.parse(await readFile(CACHE_PATH, 'utf8'))
    } catch (err) {
      log(`Could not parse existing cache (${err.message}); starting fresh.`)
    }
  }
  const baseManagers =
    existing && existing.gameweek === gameweek && existing.managers
      ? { ...existing.managers }
      : {}

  log(`Fetching picks for ${members.length} managers (concurrency=${CONCURRENCY})…`)
  let success = 0
  let failure = 0
  const failures = []
  const newManagers = { ...baseManagers }

  await mapWithConcurrency(members, CONCURRENCY, async (member) => {
    const teamId = member.entry
    const result = await fetchFplJson(FPL.picks(teamId, gameweek))
    if (!result.ok) {
      failure++
      failures.push({ teamId, name: member.player_name, status: result.status, error: result.error })
      return
    }
    const picks = (result.data?.picks || []).map((p) => ({
      element: p.element,
      multiplier: p.multiplier,
    }))
    newManagers[String(teamId)] = { picks }
    success++
  })

  log(`Picks fetched: ${success} succeeded, ${failure} failed (out of ${members.length}).`)
  if (failures.length > 0) {
    for (const f of failures) {
      log(`  fail: team=${f.teamId} (${f.name}) status=${f.status} error=${f.error}`)
    }
  }

  const cachedCount = Object.keys(newManagers).length
  if (cachedCount === 0) {
    throw new Error('zero managers cached after fetch; refusing to overwrite cache')
  }

  const output = {
    gameweek,
    fetchedAt: new Date().toISOString(),
    managers: newManagers,
  }

  await mkdir(dirname(CACHE_PATH), { recursive: true })
  await writeFile(CACHE_PATH, JSON.stringify(output, null, 2) + '\n', 'utf8')
  log(`Wrote ${CACHE_PATH} with ${cachedCount} managers cached for GW${gameweek}.`)
}

main().catch((err) => {
  console.error('[refresh-picks] FAILED:', err.message)
  process.exit(1)
})
