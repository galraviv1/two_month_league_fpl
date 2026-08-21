# FPL 2-Month League Standings

A React web app that displays Fantasy Premier League standings for a specific
league, broken down into five 2-month periods across the 2026/27 season.

## Features

- View league standings for 5 different 2-month periods
- Near-real-time scores during a live gameweek
- Transfer hits (-4/-8) deducted from period totals
- Responsive design with a modern UI
- Fast: the browser makes a single fetch for the heavy data

## 2-Month Periods

| Period              | Gameweeks |
| ------------------- | --------- |
| August + September  | GW1-5     |
| October + November  | GW6-12    |
| December + January  | GW13-23   |
| February + March    | GW24-30   |
| April + May         | GW31-38   |

Gameweek ranges are derived automatically from the FPL `phases` data each
build, so they self-correct if the fixture calendar shifts.

## Architecture

The heavy lifting (all managers, all gameweeks, plus the frozen live picks) is
precomputed by a scheduled GitHub Actions job and committed as a single static
file, `public/data/standings.json`. The deployed app fetches that one file.

```
GitHub Actions cron (every 15 min)
  └─ scripts/build-standings.mjs  ──►  FPL API (bootstrap, standings, history, picks)
        └─ writes public/data/standings.json (committed on change)

Browser
  ├─ fetch /data/standings.json          (all history + frozen live picks)
  └─ fetch /api/event/{gw}/live          (only during a live GW: player points)
```

This design exists because FPL's WAF returns 403 for the `/entry/{id}/event/{gw}/picks/`
endpoint when it is called from Vercel's data-center egress IPs. The cron runs
from a GitHub runner that FPL serves normally, so it fetches the picks once
(they are frozen at the deadline) and bakes them into the static file. During a
live gameweek the browser only needs the single `/event/{gw}/live` call, which
FPL does serve to Vercel. See [INVESTIGATION.md](INVESTIGATION.md) for the full
back-story.

## Configuration

All season-specific values live in [config.mjs](config.mjs):

```js
export const LEAGUE_ID = 367147
export const SEASON_LABEL = '2026/27'
```

To roll the app over to a new season, update those two values (the league ID is
re-issued by FPL every season) and let the cron rebuild.

## Development

```bash
npm install
npm run dev        # Vite dev server; proxies /api/event straight to FPL
```

To regenerate the standings file locally:

```bash
node scripts/build-standings.mjs
```

## Building for Production

```bash
npm run build
npm run preview
```

## Technology Stack

- **React** + **Vite** - UI and build tooling
- **Tailwind CSS** - styling
- **GitHub Actions** - scheduled data builder
- **Vercel** - static hosting + one live serverless function
- **FPL API** - data source

## License

ISC

## Credits

Data provided by the official Fantasy Premier League API.
