// Vercel serverless function to proxy FPL manager picks API
export default async function handler(req, res) {
  const { teamId, eventId } = req.query;
  
  try {
    const response = await fetch(`https://fantasy.premierleague.com/api/entry/${teamId}/event/${eventId}/picks/`);
    const data = await response.json();
    
    // Set CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET');
    // Picks data should not be cached as it can change during live gameweeks
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    
    res.status(200).json(data);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch manager picks' });
  }
}

