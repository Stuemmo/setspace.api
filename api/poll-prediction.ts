// /api/poll-prediction.ts

export const config = {
  runtime: 'nodejs'
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    const { predictionId } = req.query;
    if (!predictionId) {
      return res.status(400).json({ error: 'Missing predictionId' });
    }

    const response = await fetch(`https://api.replicate.com/v1/predictions/${predictionId}`, {
      headers: {
        'Authorization': `Token ${process.env.REPLICATE_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("❌ Replicate polling error:", errorText);
      throw new Error(`Replicate status check failed`);
    }

    const prediction = await response.json();
    return res.status(200).json({ success: true, prediction });
    
  } catch (error) {
    console.error("❌ Polling handler failed:", error);
    return res.status(500).json({ error: error.message });
  }
}
