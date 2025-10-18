# FPL 2-Month League Standings

A React web application that displays Fantasy Premier League standings for a specific league broken down by 2-month periods throughout the 2024/25 season.

## Features

- 📊 View league standings for 5 different 2-month periods
- 🏆 Real-time data fetched from official FPL API
- 📱 Responsive design with modern UI
- ⚡ Fast performance with React and Vite
- 🎨 Beautiful styling with Tailwind CSS

## 2-Month Periods

The app divides the FPL season into 5 periods:

1. **August + September** - Early season form
2. **October + November** - Autumn period
3. **December + January** - Winter fixtures
4. **February + March** - Spring run-in
5. **April + May** - Season finale

## Installation

1. **Clone the repository** (or you're already here!)

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Start the development server:**
   ```bash
   npm run dev
   ```

4. **Open your browser** and navigate to the URL shown in the terminal (usually `http://localhost:5173`)

## Usage

1. The app automatically loads data for your league (ID: 286461) on startup
2. Use the dropdown menu to select a 2-month period
3. View the standings table showing:
   - Rank within the selected period
   - Manager name
   - Team name
   - Total points for that period

## How It Works

The app fetches data from three FPL API endpoints:

1. **Bootstrap API** - Gets gameweek information and deadline dates
2. **League API** - Gets all managers in the league
3. **Manager History API** - Gets individual gameweek points for each manager

It then:
- Maps each gameweek to a specific month based on its deadline date
- Groups gameweeks into 2-month periods
- Calculates total points for each manager in the selected period
- Ranks managers by their period points

## Building for Production

To create a production build:

```bash
npm run build
```

To preview the production build:

```bash
npm run preview
```

## Technology Stack

- **React** - UI library
- **Vite** - Build tool and dev server
- **Tailwind CSS** - Styling
- **FPL API** - Data source

## League Configuration

To use this app for a different league:

1. Open `src/App.jsx`
2. Find the line: `const LEAGUE_API = 'https://fantasy.premierleague.com/api/leagues-classic/286461/standings/'`
3. Replace `286461` with your league ID

## Notes

- The app fetches data for all managers on initial load, which may take a few seconds
- Data is cached to avoid refetching when switching between periods
- All calculations are done client-side
- No backend or database required

## License

ISC

## Credits

Data provided by the official Fantasy Premier League API.
