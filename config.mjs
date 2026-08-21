// Shared configuration for both the build script (Node) and the frontend (Vite).
// To roll the app over to a new FPL season, update LEAGUE_ID and SEASON_LABEL.

export const LEAGUE_ID = 367147
export const SEASON_LABEL = '2026/27'

// The five two-month competition periods. `months` are 1-12 calendar months;
// the build script resolves these to actual gameweek numbers using the
// `phases` array from bootstrap-static.
export const PERIODS = [
  { id: 'aug-sep', name: 'August + September', months: [8, 9] },
  { id: 'oct-nov', name: 'October + November', months: [10, 11] },
  { id: 'dec-jan', name: 'December + January', months: [12, 1] },
  { id: 'feb-mar', name: 'February + March', months: [2, 3] },
  { id: 'apr-may', name: 'April + May', months: [4, 5] },
]

// FPL `phases` use full English month names; map them to 1-12.
export const MONTH_NAME_TO_NUMBER = {
  January: 1,
  February: 2,
  March: 3,
  April: 4,
  May: 5,
  June: 6,
  July: 7,
  August: 8,
  September: 9,
  October: 10,
  November: 11,
  December: 12,
}
