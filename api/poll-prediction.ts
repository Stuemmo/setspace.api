// /api/poll-prediction.ts

import { VercelRequest, VercelResponse } from '@vercel/node';
import Replicate from 'replicate';

const replicate = new Replicate({
  auth: process.env.REPLICATE_API_KEY,
});

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const { predictionId } = req.query;

    if (!predictionId || typeof predictionId !== 'string') {
      return res.status(400).json({ error: 'Missing or invalid predictionId' });
    }

    console.log(`🔍 Polling prediction status for ID: ${predictionId}`);

    const prediction = await replicate.predictions.get(predictionId);

    if (!prediction) {
      throw new Error('Prediction not found');
    }

    return res.status(200).json({ status: prediction.status, output: prediction.output });
  } catch (error) {
    console.error('❌ Polling failed:', error);
    return res.status(500).json({ error: (error as Error).message });
  }
}
