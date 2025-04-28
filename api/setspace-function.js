import { createClient } from '@supabase/supabase-js';

// Pure Vercel serverless function
export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    return res.status(200).setHeader('Access-Control-Allow-Origin', '*')
      .setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
      .setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
      .end();
  }

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  const SUPABASE_URL = process.env.PROJECT_URL;
  const SERVICE_ROLE_KEY = process.env.SERVICE_ROLE_KEY;
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  const REPLICATE_API_KEY = process.env.REPLICATE_API_KEY;

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  try {
    const { jobId, filename, smallImageBase64, imageUrl } = req.body;

    if (!jobId || !filename || !smallImageBase64) {
      throw new Error('Missing jobId, filename, or smallImageBase64');
    }

    const { data: jobRows, error: jobRowError } = await supabase
      .from('jobs')
      .select('camera_control, video_size, duration')
      .eq('id', jobId);

    if (jobRowError || !jobRows || jobRows.length !== 1) {
      throw new Error('Could not find unique job row');
    }

    const { camera_control, video_size, duration } = jobRows[0];
    const cameraControl = camera_control ?? 'stationary';
    const videoSize = video_size ?? '720p';
    const videoDuration = duration ?? 5;

    // Decode base64 image
    const buffer = Buffer.from(smallImageBase64, 'base64');

    const smallPath = `jobs/${filename}`;
    const { error: uploadError } = await supabase
      .storage
      .from('uploads-small')
      .upload(smallPath, buffer, {
        contentType: 'image/jpeg',
        upsert: true,
      });

    if (uploadError) {
      throw new Error(`Upload failed: ${uploadError.message}`);
    }

    // Sign URL
    const { data: signedUrlData } = await supabase
      .storage
      .from('uploads-small')
      .createSignedUrl(smallPath, 900);

    const signedSmallImageUrl = signedUrlData?.signedUrl;

    await supabase.from('jobs').update({
      small_image_url: signedSmallImageUrl,
    }).eq('id', jobId);

    // OpenAI prompt
    const openaiPrompt = `Create a cinematic description of this interior scene for video animation.
Use natural movement only — such as light flicker, curtain sway, tree motion, or shifting shadows.
Camera movement should follow this instruction: "${cameraControl}".
Do not alter the structure of the space. Maintain realism and elegance.`;

    let prompt = 'A cinematic scene.';

    try {
      const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'gpt-4-vision-preview',
          messages: [
            { role: 'user', content: [
              { type: 'text', text: openaiPrompt },
              { type: 'image_url', image_url: { url: signedSmallImageUrl } }
            ]}
          ],
          max_tokens: 150
        }),
      });

      const openaiData = await openaiRes.json();
      prompt = openaiData?.choices?.[0]?.message?.content?.trim() || prompt;
    } catch (error) {
      console.error('⚠️ OpenAI error fallback:', error.message);
    }

    // Trigger Replicate
    const replicateInitRes = await fetch('https://api.replicate.com/v1/models/kwaivgi/kling-v1.6-standard/predictions', {
      method: 'POST',
      headers: {
        Authorization: `Token ${REPLICATE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        input: {
          start_image: imageUrl ?? signedSmallImageUrl,
          prompt,
          duration: videoDuration,
        }
      }),
    });

    const replicateInitData = await replicateInitRes.json();
    const predictionId = replicateInitData.id;

    await supabase.from('jobs').update({
      prompt,
      replicate_prediction_id: predictionId,
      status: 'generating',
      updated_at: new Date().toISOString(),
    }).eq('id', jobId);

    return res.status(200).json({ success: true, predictionId });

  } catch (err) {
    console.error('❌ Serverless Error:', err.message);
    return res.status(500).json({ error: err?.message || 'Unknown error' });
  }
}
