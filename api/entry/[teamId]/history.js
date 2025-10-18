// Vercel serverless function to proxy FPL manager history API
export default async function handler(req, res) {
  const { teamId } = req.query;
  
  try {
    const response = await fetch(`https://fantasy.premierleague.com/api/entry/${teamId}/history/`);
    const data = await response.json();
    
    // Set CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET');
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate');
    
    res.status(200).json(data);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch manager history' });
  }
}

