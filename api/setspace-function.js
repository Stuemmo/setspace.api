import { createClient } from '@supabase/supabase-js';
import Replicate from 'replicate';
import fetch from 'node-fetch';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SERVICE_ROLE_KEY;
const openaiApiKey = process.env.OPENAI_API_KEY;
const replicateApiKey = process.env.REPLICATE_API_KEY;

const supabase = createClient(supabaseUrl, supabaseKey);
const replicate = new Replicate({ auth: replicateApiKey });

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  try {
    const { jobId, filename, smallImageBase64, imageUrl, cameraControl, videoSize, duration } = req.body;

console.log("📦 Payload received by server:", {
  jobId,
  filename,
  imageUrl,
  cameraControl,
  videoSize,
  duration,
  smallImageBase64: smallImageBase64?.slice(0, 30) + '...',
});
if (!jobId || !filename || !smallImageBase64 || !imageUrl || !cameraControl || !videoSize || !duration) {
      console.error('❌ Missing required fields', req.body);
      return res.status(400).json({ error: 'Missing required fields' });
    }

    console.log(`🚀 Starting video generation for job: ${jobId}`);

    // ✅ Ensure filename ends with .jpg for Kling compatibility
    const safeFilename = filename.endsWith('.jpg') ? filename : `${filename}.jpg`;
    const uploadPath = `small/${safeFilename}`;

    const buffer = Buffer.from(smallImageBase64, 'base64');

    const { error: uploadError } = await supabase.storage.from('uploads').upload(uploadPath, buffer, {
      contentType: 'image/jpeg',
      upsert: true,
    });

    if (uploadError) {
      console.error('❌ Upload error:', uploadError);
      throw new Error('Failed to upload small image');
    }

    console.log('✅ Small image uploaded.');

    const { data: signedUrlData, error: signedUrlError } = await supabase.storage.from('uploads').createSignedUrl(uploadPath, 5 * 60);

    if (signedUrlError) {
      console.error('❌ Signed URL error:', signedUrlError);
      throw new Error('Failed to create signed URL');
    }

    const signedImageUrl = signedUrlData.signedUrl;
    console.log('✅ Signed image URL created:', signedImageUrl);

    let cinematicPrompt = "A cinematic scene.";
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
            { role: 'system', content: 'You are a cinematic scene director.' },
            {
              role: 'user',
              content: [
                { type: 'text', text: `Create a cinematic description of this interior scene for video animation. Use natural movement only (light flicker, curtain sway, tree motion, shifting shadows). Camera movement: "${cameraControl}". Do not alter the structure of the space. Keep realism and elegance.` },
                { type: 'image_url', image_url: signedImageUrl }
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

    const klingVersion = videoSize === '1080p'
      ? 'ab4d34d6acd764074179a8139cfb9b55803aecf0cfb83061707a0561d1616d50'
      : '7e324e5fcb9479696f15ab6da262390cddf5a1efa2e11374ef9d1f85fc0f82da';

    console.log(`🎥 Using Kling version: ${klingVersion}`);

    const prediction = await replicate.predictions.create({
      version: klingVersion,
      input: { prompt: cinematicPrompt, start_image: signedImageUrl }
    });

    if (!prediction?.id) {
      console.error('❌ No prediction ID received:', prediction);
      throw new Error('Replicate prediction failed: No valid ID.');
    }

    console.log('✅ Prediction triggered:', prediction.id);

    return res.status(200).json({
      success: true,
      predictionId: prediction.id
    });

  } catch (error) {
    console.error('❌ Video generation failed:', error);
    return res.status(500).json({ error: error.message });
  }
}
