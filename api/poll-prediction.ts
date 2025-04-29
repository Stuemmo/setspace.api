// /api/poll-prediction.ts

export const config = {
  runtime: 'edge'
};

export default async function handler(req: Request) {
  const url = new URL(req.url);
  const predictionId = url.searchParams.get('predictionId');

  if (!predictionId) {
    return new Response(JSON.stringify({ error: 'Missing predictionId' }), {
      status: 400,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      }
    });
  }

  try {
    const response = await fetch(`https://api.replicate.com/v1/predictions/${predictionId}`, {
      headers: {
        'Authorization': `Token ${process.env.REPLICATE_API_KEY}`,
        'Content-Type': 'application/json',
      }
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("❌ Replicate polling error:", errorText);
      throw new Error(`Replicate status check failed`);
    }

    const prediction = await response.json();

    return new Response(JSON.stringify({ success: true, prediction }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      }
    });

  } catch (error: any) {
    console.error("❌ Polling handler failed:", error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      }
    });
  }
}
