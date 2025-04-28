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

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const { jobId, filename, smallImageBase64, imageUrl, cameraControl, videoSize } = req.body;

    if (!jobId || !filename || !smallImageBase64 || !imageUrl || !cameraControl || !videoSize) {
      console.error('Missing required fields', req.body);
      return res.status(400).json({ error: 'Missing required fields' });
    }

    console.log(`Starting video generation for job ${jobId}`);

    // Upload small image to Supabase Storage
    const buffer = Buffer.from(smallImageBase64, 'base64');
    const uploadPath = `small/${filename}`;

    const { data: uploadData, error: uploadError } = await supabase
      .storage
      .from('uploads')
      .upload(uploadPath, buffer, {
        contentType: 'image/jpeg',
        upsert: true,
      });

    if (uploadError) {
      console.error('Upload error:', uploadError);
      throw new Error('Failed to upload small image');
    }

    console.log('Small image uploaded:', uploadData);

    // Get signed URL for the uploaded small image
    const { data: signedUrlData, error: signedUrlError } = await supabase
      .storage
      .from('uploads')
      .createSignedUrl(uploadPath, 60 * 60); // 1 hour expiry

    if (signedUrlError) {
      console.error('Signed URL error:', signedUrlError);
      throw new Error('Failed to create signed URL');
    }

    const signedImageUrl = signedUrlData.signedUrl;

    console.log('Signed image URL:', signedImageUrl);

    // Prepare OpenAI prompt
    let cinematicPrompt = "A cinematic scene."; // fallback

    try {
      console.log('Calling OpenAI Vision API to generate prompt...');

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
                  text: `Create a cinematic description of this interior scene for video animation. \nUse natural movement only — such as light flicker, curtain sway, tree motion, or shifting shadows.\nCamera movement should follow this instruction: \"${cameraControl}\". \nDo not alter the structure of the space. Maintain realism and elegance.`
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

      if (visionData.choices && visionData.choices[0]?.message?.content) {
        cinematicPrompt = visionData.choices[0].message.content.trim();
        console.log('Generated OpenAI prompt:', cinematicPrompt);
      } else {
        console.warn('OpenAI fallback used (no content returned).');
      }

    } catch (err) {
      console.error('OpenAI Vision API error:', err);
      console.warn('Falling back to generic prompt.');
    }

    // Choose Kling model
    let klingModelVersion;
    if (videoSize === '1080p') {
      klingModelVersion = 'kwaivgi/kling-v1.6-pro';
    } else {
      klingModelVersion = 'kwaivgi/kling-v1.6-standard';
    }

    console.log(`Selected Kling model: ${klingModelVersion}`);

    // Call Replicate
    console.log('Calling Replicate with signed image and cinematic prompt...');

    const output = await replicate.run(klingModelVersion, {
      input: {
        prompt: cinematicPrompt,
        start_image: imageUrl
      }
    });

    console.log('Replicate output received.');

    return res.status(200).json({ success: true, replicateOutput: output });

  } catch (error) {
    console.error('Video generation failed:', error);
    return res.status(500).json({ error: error.message });
  }
}
