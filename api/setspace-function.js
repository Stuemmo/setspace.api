// /api/setspace-function.js

import { createClient } from '@supabase/supabase-js';
import Replicate from 'replicate';
import { Readable } from 'stream';
import fetch from 'node-fetch';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SERVICE_ROLE_KEY;
const openaiApiKey = process.env.OPENAI_API_KEY;
const replicateApiKey = process.env.REPLICATE_API_KEY;

const supabase = createClient(supabaseUrl, supabaseKey);
const replicate = new Replicate({ auth: replicateApiKey });

export default async function handler(req, res) {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  try {
    // 1. Validate incoming fields
    const { jobId, filename, smallImageBase64, imageUrl, cameraControl, videoSize } = req.body;
    if (!jobId || !filename || !smallImageBase64 || !imageUrl || !cameraControl || !videoSize) {
      console.error('❌ Missing required fields', req.body);
      return res.status(400).json({ error: 'Missing required fields' });
    }

    console.log(`🚀 Starting video generation for job: ${jobId}`);

    // 2. Upload small image to Supabase
    const buffer = Buffer.from(smallImageBase64, 'base64');
    const uploadPath = `small/${filename}`;

    const { error: uploadError } = await supabase
      .storage
      .from('uploads')
      .upload(uploadPath, buffer, {
        contentType: 'image/jpeg',
        upsert: true,
      });

    if (uploadError) {
      console.error('❌ Upload error:', uploadError);
      throw new Error('Failed to upload small image');
    }

    console.log('✅ Small image uploaded.');

    // 3. Create signed URL
    const { data: signedUrlData, error: signedUrlError } = await supabase
      .storage
      .from('uploads')
      .createSignedUrl(uploadPath, 5 * 60); // 5 minutes expiry

    if (signedUrlError) {
      console.error('❌ Signed URL error:', signedUrlError);
      throw new Error('Failed to create signed URL');
    }

    const signedImageUrl = signedUrlData.signedUrl;
    console.log('✅ Signed image URL created.');

    // 4. Generate cinematic prompt via OpenAI
    let cinematicPrompt = "A cinematic scene."; // fallback

    try {
      console.log('🧠 Calling OpenAI Vision to generate cinematic prompt...');
      const visionResponse = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${openaiApiKey}`
        },
        body: JSON.stringify({
          model: 'gpt-4-vision-preview',
          messages: [
            {
              role: 'system',
              content: 'You are a cinematic scene director.'
            },
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: `Create a cinematic description of this interior scene for video animation. 
Use natural movement only (light flicker, curtain sway, tree motion, shifting shadows).
Camera movement: "${cameraControl}".
Do not alter the structure of the space. Keep realism and elegance.`
                },
                {
                  type: 'image_url',
                  image_url: signedImageUrl
                }
              ]
            }
          ],
          max_tokens: 300
        })
      });

      const visionData = await visionResponse.json();

      if (visionData?.choices?.[0]?.message?.content) {
        cinematicPrompt = visionData.choices[0].message.content.trim();
        console.log('✅ Cinematic prompt generated.');
      } else {
        console.warn('⚠️ OpenAI fallback: no cinematic prompt content.');
      }

    } catch (openaiError) {
      console.error('❌ OpenAI Vision API error:', openaiError);
      console.warn('⚠️ Falling back to generic prompt.');
    }

   // 5. Select Kling model and version
let klingModel, klingVersion;

if (videoSize === '1080p') {
  klingModel = 'kwaivgi/kling-v1.6-pro';
  klingVersion = 'ab4d34d6acd764074179a8139cfb9b55803aecf0cfb83061707a0561d1616d50';
} else {
  klingModel = 'kwaivgi/kling-v1.6-standard';
  klingVersion = '7e324e5fcb9479696f15ab6da262390cddf5a1efa2e11374ef9d1f85fc0f82da';
}

console.log(`🎥 Using Kling model: ${klingModel} with version: ${klingVersion}`);

// 6. Fire Replicate prediction (async)
console.log('📤 Triggering Replicate prediction...');

const prediction = await replicate.predictions.create({
  model: klingModel,
  version: klingVersion,
  input: {
    prompt: cinematicPrompt,
    start_image: signedImageUrl
  }
});

console.log('✅ Prediction triggered:', prediction.id);

    // 7. Optional: Save prediction ID to Supabase jobs table (if tracking)
    // await supabase.from('jobs').update({ replicate_prediction_id: prediction.id }).eq('id', jobId);

    // 8. Return immediately with prediction ID
    return res.status(200).json({
      success: true,
      predictionId: prediction.id
    });

  } catch (error) {
    console.error('❌ Video generation failed:', error);
    return res.status(500).json({ error: error.message });
  }
}
