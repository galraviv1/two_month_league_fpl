// Vercel serverless function to proxy FPL live gameweek data API
export default async function handler(req, res) {
  const { eventId } = req.query;
  
  try {
    const response = await fetch(`https://fantasy.premierleague.com/api/event/${eventId}/live/`);
    const data = await response.json();
    
    // Set CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET');
    // Live data should not be cached as it changes frequently
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    
    res.status(200).json(data);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch live gameweek data' });
  }
}

