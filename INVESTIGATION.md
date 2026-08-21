# Live Points / "Silent 0" Investigation

A running record of the bug hunt that started on May 1 2026 around the
"some managers show 0 points" symptom in the 2-month standings, and the
deeper Vercel-egress / FPL-WAF problem it exposed.

---

## 1. The original symptom

When viewing the **February + March** standings on the deployed app, three
managers were showing **0 points**:

| Manager        | Team             | Shown points |
| -------------- | ---------------- | -----------: |
| Roei Eitan     | Roei's team      |            0 |
| Ilay Konfeld   | Konfeld          |            0 |
| Adir Sabag     | Tutim            |            0 |

These were not new managers — pulling the same data straight from the FPL
API showed they each had a normal, non-zero return per gameweek:

| Manager        | Real GW25–31 sum |
| -------------- | ---------------: |
| Roei Eitan     |              393 |
| Ilay Konfeld   |              427 |
| Adir Sabag     |              323 |

So real points were being silently lost in the app.

---

## 2. First diagnosis — frontend silently swallowed errors

In `src/App.jsx`, `fetchAllData` was firing all 30 manager-history requests
in parallel:

```js
const managersWithHistory = await Promise.all(
  members.map(async (member) => {
    try {
      const history = await fetchManagerHistory(member.entry)
      return { ..., history }
    } catch (err) {
      console.error(...)
      return { ..., history: [] }   // <- this is the bug
    }
  })
)
```

Vercel's serverless functions cold-start; under a 30-call burst, a few of
the upstream calls were failing. The frontend's `catch` block replaced any
failure with `history: []`, which downstream summed to `0` and was rendered
as a real-looking score. The user has no way to tell that "0" means
"missing data" vs. "actually scored 0".

We verified this matched the Console output (`Failed to fetch history for
…`) on the deployed site.

The bug is **non-deterministic** — different page loads can drop different
managers from the standings, and could in principle swap the leaderboard
position of a podium contender on a given load. We confirmed that on the
load we examined, the 1st-place winner of each completed period was still
correct, but the affected managers were stuck at 0 mid-table.

### Confirmed real winners across all 5 periods

| Period             | Status        | True 1st place                             | Points |
| ------------------ | ------------- | ------------------------------------------ | -----: |
| August + September | Completed     | Dor Cohen *(Yellow kingdom)*               |    392 |
| October + November | Completed     | koren kalai *(Calafiornication)*           |    457 |
| December + January | Completed     | Uriya Yakobi *(Rice Rice Baby)*            |    698 |
| February + March   | Completed     | Aviv Liefer *(Heta Pali)*                  |    469 |
| April + May        | In progress   | Liam rakin *(SunderDogs)* *(at GW3 of 7)*  |    245 |

---

## 3. First fix — throttle and badge (commit `1f72a74`)

Implemented in `src/App.jsx`:

1. Added a small `mapWithConcurrency(items, limit, fn)` helper.
2. Replaced the `Promise.all(members.map(...))` history fan-out with
   `mapWithConcurrency(members, 5, ...)` — at most 5 in-flight history
   calls instead of 30 simultaneously.
3. Added a `fetchFailed: true` flag on the rare failure path.
4. Sort failed rows to the bottom of the table.
5. Render a yellow **"data unavailable"** badge in the points cell instead
   of a misleading 0.

After deploy, the affected managers' Feb–Mar totals returned to their real
values, and the visual contract changed: a real 0 looks different from a
data-missing row.

---

## 4. Second symptom — same shape, in the live-GW path (commit `bfea284`)

After the first fix, browsing the **April + May** period (which contains
the currently-live GW35) surfaced a second pile of 500s in the Console:

```
GET .../api/entry/<id>/event/35/picks → 500 (Internal Server Error)
Failed to get live points for <manager>: …
```

Looking at `calculateStandings`, the live-points path had the **identical
bug shape** as the original one: a `Promise.all(managers.map(...))` fan-out
that called `/picks/` 30 times in parallel and silently swallowed failures
into `livePoints = 0`. With the live GW excluded from the historical sum,
the affected managers showed *partial* totals (everything except the live
GW) — visually indistinguishable from a complete lower score.

### Fix (commit `bfea284`)

In `src/App.jsx` `calculateStandings`:

1. Replaced `Promise.all(managers.map(...))` with
   `mapWithConcurrency(managers, 5, ...)`.
2. Added a `livePartial: true` flag for any row whose live-picks fetch
   failed.
3. Sort: complete rows → `livePartial` rows → `fetchFailed` rows.
4. UI: an orange **"live GW missing"** badge under the points number for
   `livePartial` rows. Their historical-only total is still shown above so
   the partial nature is visible.

---

## 5. Things still failed in production — deeper investigation

After the second fix deployed, the app still showed many "live GW missing"
badges on April + May.

Hit the deployed Vercel URL from a Node script with the same concurrency
patterns the app uses:

| Endpoint                                        | Calls | Failures   |
| ----------------------------------------------- | ----: | ---------- |
| `/api/bootstrap-static`                         |    1  | 0          |
| `/api/leagues-classic/286461/standings`         |    1  | 0          |
| `/api/entry/{id}/history`                       |   30  | 0          |
| `/api/event/35/live`                            |    1  | 0          |
| `/api/entry/{id}/event/35/picks` (concurrency 5)|   30  | **5–8**    |
| `/api/entry/{id}/event/35/picks` (concurrency 1)|   30  | **30 (!)** |
| `/api/entry/{id}/event/35/picks` (concurrency 3)|   30  | 15         |

Crucial observations:

- **Only `/picks/` fails.** Every other endpoint is fine through the same
  Vercel infra.
- **Sequential is *worse* than parallel.** That's the opposite of rate
  limiting. It implies each function invocation has an independent ~50–60 %
  chance of failing, regardless of pacing.
- **Failures are fast** (~180 ms) and all return the same body
  `{"error":"Failed to fetch manager picks"}` — that's the catch block in
  the serverless handler. Something inside the function is throwing fast.
- The same picks URL hit 5× in a row from the same client returned
  `500, 500, 500, 200, 200`. So the failure is per-invocation, not per
  team.

Direct calls to FPL from a residential IP (this laptop) succeed 30/30 and
10/10 with every User-Agent variant. So the issue is **not the client UA
in general** but rather **FPL responding differently to Vercel's
data-center egress IPs specifically on the `/picks/` path**.

The serverless function ([api/entry/[teamId]/event/[eventId]/picks.js](api/entry/%5BteamId%5D/event/%5BeventId%5D/picks.js)
at the time) had no error visibility:

```js
try {
  const response = await fetch(...)
  const data = await response.json()       // throws on non-JSON
  res.status(200).json(data)
} catch (error) {
  res.status(500).json({ error: 'Failed to fetch manager picks' })
}
```

Any non-2xx, any non-JSON body, any thrown error all became the same
opaque 500. We had no idea what FPL was actually saying.

---

## 6. Third fix — server-side helper with retries and real error reporting (commit `cf1d8f7`)

Created `api/_lib/proxyFpl.js` with a shared `fetchFplJson(upstreamUrl)`
that:

- Sends a real `User-Agent` and `Accept: application/json`.
- Validates `response.ok` **and** `content-type: application/json` before
  parsing.
- Retries up to 2 extra times (3 attempts total) with 250 ms / 500 ms
  backoff.
- On final failure, returns the actual upstream status code + a 200-char
  body preview, instead of swallowing it as a 500.

Applied the helper to the two high-fanout serverless functions:

- `api/entry/[teamId]/event/[eventId]/picks.js`
- `api/entry/[teamId]/history.js`

---

## 7. Result of the third fix — and the **current** problem

After deploy:

| Endpoint                                       | Failures     |
| ---------------------------------------------- | -----------: |
| `/api/entry/{id}/history` (30 teams, conc. 5)  | **0 / 30**   |
| `/api/entry/{id}/event/35/picks` (sequential)  | **5 / 5**    |
| `/api/entry/{id}/event/35/picks` (30, conc. 5) | **23–26 / 30** |

The **history endpoint is now perfect** — the marginal flakiness it had
was real transient noise that the retry + UA cured.

The **picks endpoint got worse**, and now the new error reporting tells us
exactly why every failure is the same:

```
status=403  detail="FPL 403 (ct=none)"  upstreamPreview=""
```

In other words, FPL is responding to Vercel's egress with **HTTP 403, no
content-type, no body** for the picks endpoint specifically. The 3 retries
all hit the same wall within ~1 second because they go from the same
Vercel egress instance — so the WAF flag is still active for the whole
retry window.

This isn't something the existing code can change:

- It is **not** a User-Agent issue (every UA tested from a residential IP
  succeeds 100 %).
- It is **not** rate limiting in the usual sense — sequential is worse
  than parallel from Vercel.
- It is **not** an FPL-wide block on Vercel — every other FPL endpoint
  works fine through the same proxy.
- The retry logic is firing as designed; the upstream is returning 403 to
  every attempt.

This points at FPL/Cloudflare having a **per-egress-IP, per-endpoint WAF
rule** that flags the cloud provider IP ranges that Vercel uses for the
picks endpoint specifically. There is no `User-Agent` or retry strategy
the serverless function can use that defeats this from inside the same
function invocation, because a flagged IP stays flagged within the retry
window.

### What this means in practice

- The **leaderboard for finished gameweeks is correct** — history fetches
  succeed reliably.
- During a **live gameweek** (e.g. April + May right now), most managers'
  live points cannot be retrieved from Vercel; the UI correctly shows the
  orange **"live GW missing"** badge for them and ranks them based on
  historical points only. The badge prevents misleading numbers.
- A small number of managers' live points do come through on each load
  (the lucky ones whose calls happen to hit a non-flagged Vercel egress
  instance), but the picture is never complete in a single page load.

### Open question

Whether FPL's apparent block is **stable / sticky** or **rolling**.
If the same Vercel egress IP could re-attempt successfully after some
cool-off period, then any caching / staggered-retry approach would
gradually fill in coverage; if the block is permanent for every Vercel
egress IP in the relevant region, no client-side strategy from inside
Vercel can fix it without a different network path. We do not yet know
which it is.

---

## 8. Summary of files and commits

```
src/App.jsx                                       — frontend (throttle, badges)
api/_lib/proxyFpl.js                              — shared fetch helper (NEW)
api/entry/[teamId]/history.js                     — uses helper
api/entry/[teamId]/event/[eventId]/picks.js      — uses helper
```

| Commit       | Title                                                         |
| ------------ | ------------------------------------------------------------- |
| `1f72a74`    | fix: throttle manager history fetches and badge failed loads |
| `bfea284`    | fix: throttle live picks and badge partial-live rows          |
| `cf1d8f7`    | fix(api): add UA, validate JSON, retry, and forward FPL errors |

---

## 9. Personal notes / observations

- The pattern of "wrap a fan-out in `Promise.all`, swallow failures into
  empty data, render the empty data as if it were real" appeared **twice**
  in this codebase (history + picks). A short rule for future code in this
  app: never let a network failure turn into "0" in the UI without an
  explicit visible marker.
- The serverless function pattern of `try { fetch().json() } catch {
  res.status(500) }` discards the actual upstream status. Any future proxy
  function in this repo should at minimum check `response.ok` and forward
  the real status, otherwise debugging is "what is this generic 500".
- The fact that the picks endpoint behaves differently from every other
  FPL endpoint is interesting in its own right. Picks is the only endpoint
  that returns a **manager-private** payload (chip usage, captain choice
  etc.). Plausible that FPL applies tighter WAF rules there.
- This investigation was greatly accelerated by *not* trusting the app's
  own error messages and going directly to `curl`/Node-level reproductions
  against both Vercel and FPL. The most useful single change of the whole
  series was the one that **stopped hiding the upstream error**.

---

## 10. 2026/27 season rollover — the fan-out was removed by design

At the start of the 2026/27 season the app was repointed from the (now
reused) league `286461` to the new league `367147` ("The English Game").
That rollover was also the moment to act on the central lesson above: the
browser fan-out was the root cause of every bug in this document, so it was
removed entirely rather than patched again.

### What changed architecturally

- **All heavy data is now precomputed** by `scripts/build-standings.mjs`,
  run by a GitHub Actions cron every 15 minutes, and committed to
  `public/data/standings.json`. The browser makes **one** `fetch` for that
  file instead of ~60 fan-out requests (30 history + 30 picks).
- **The Vercel WAF problem is designed around, not fought.** The cron runs
  from a GitHub runner (residential-style egress FPL serves normally), so it
  fetches `/picks/` there once — picks are frozen at the deadline — and bakes
  them into the static file. Only `/event/{gw}/live` (which Vercel *can*
  reach) remains as a browser-side serverless call, for live player points.
- **The four proxy functions that fanned out are gone** (`bootstrap-static`,
  `leagues-classic/.../standings`, `entry/.../history`,
  `entry/.../event/.../picks`). Only `event/[eventId]/live.js` remains, now
  using the `fetchFplJson` helper it never adopted.
- **`refresh-picks.mjs` / `refresh-picks.yml` → `build-standings.mjs` /
  `build-standings.yml`.** The old cron was found `disabled_manually` and had
  been dead since mid-July; the new one is on a 15-minute schedule.

### Other correctness fixes made at the same time

- **`new_entries` handling.** Pre-season, FPL returns every manager in
  `new_entries.results` (with `player_first_name`/`player_last_name`) while
  `standings.results` is empty. The old code read only `standings.results`
  and would have rendered an empty table until the first GW was scored. The
  builder now unions both lists.
- **Transfer hits are deducted.** Period totals now use
  `points - event_transfers_cost` per gameweek (net), not the gross
  per-gameweek `points`. The builder logs a self-check comparing the running
  net sum against `total_points` so the gross-vs-net question is settled
  empirically the first time a GW is scored.
- **Periods come from `phases`, not local-timezone deadline parsing.** The
  old `mapGameweeksToPeriods` bucketed gameweeks by
  `new Date(deadline_time).getMonth()` in the *browser's* timezone, which can
  push a late-night-UTC deadline into the wrong month. The builder now uses
  FPL's own `phases` month ranges.

### The one thing kept from the old error handling

The **"live GW missing"** badge. It is the concrete embodiment of the rule
from section 9: if the cron has not yet captured a manager's picks for the
live gameweek, that manager is shown with historical points only and an
explicit badge — never a silently-complete-looking score.
