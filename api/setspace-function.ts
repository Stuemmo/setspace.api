import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js";
serve(async (req)=>{
  const SUPABASE_URL = Deno.env.get("PROJECT_URL");
  const SERVICE_ROLE_KEY = Deno.env.get("SERVICE_ROLE_KEY");
  const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");
  const REPLICATE_API_KEY = Deno.env.get("REPLICATE_API_KEY");
  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  // 🔥 Dynamic CORS
  const allowedOrigins = [
    "https://prop-ai-cinema.lovable.app",
    "https://preview--prop-ai-cinema.lovable.app"
  ];
  const requestOrigin = req.headers.get("origin") || "";
  const corsHeaders = {
    "Access-Control-Allow-Origin": allowedOrigins.includes(requestOrigin) ? requestOrigin : allowedOrigins[0],
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization"
  };
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: corsHeaders
    });
  }
  let jobId, filename, smallImageBase64, imageUrl;
  try {
    const body = await req.json();
    jobId = body.jobId;
    filename = body.filename;
    smallImageBase64 = body.smallImageBase64;
    imageUrl = body.imageUrl ?? null;
    if (!jobId || !filename || !smallImageBase64) {
      throw new Error("Missing jobId, filename, or smallImageBase64");
    }
  } catch (err) {
    console.error("❌ Invalid JSON body:", err);
    return new Response(JSON.stringify({
      error: "Invalid JSON body"
    }), {
      status: 400,
      headers: corsHeaders
    });
  }
  console.log("▶️ Starting job:", jobId);
  try {
    const { data: jobRows, error: jobRowError } = await supabase.from("jobs").select("camera_control, video_size, duration").eq("id", jobId);
    if (jobRowError || !jobRows || jobRows.length !== 1) {
      throw new Error("Could not find unique job row");
    }
    const { camera_control, video_size, duration } = jobRows[0];
    const cameraControl = camera_control ?? "stationary";
    const videoSize = video_size ?? "720p";
    const videoDuration = duration ?? 5;
    const binary = atob(smallImageBase64);
    const bytes = new Uint8Array(binary.length);
    for(let i = 0; i < binary.length; i++){
      bytes[i] = binary.charCodeAt(i);
    }
    const smallBlob = new Blob([
      bytes
    ], {
      type: "image/jpeg"
    });
    const smallPath = `jobs/${filename}`;
    const { error: uploadError } = await supabase.storage.from("uploads-small").upload(smallPath, smallBlob, {
      contentType: "image/jpeg",
      upsert: true
    });
    if (uploadError) {
      console.error("🛑 Upload failed:", uploadError.message);
      throw new Error(`Upload failed: ${uploadError.message}`);
    }
    console.log("✅ Small image uploaded to uploads-small");
    const signSmallRes = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/uploads-small/${smallPath}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        expiresIn: 900
      })
    });
    const { signedURL: smallSignedURL } = await signSmallRes.json();
    const signedSmallImageUrl = `${SUPABASE_URL}/storage/v1/${smallSignedURL}`;
    await supabase.from("jobs").update({
      small_image_url: signedSmallImageUrl
    }).eq("id", jobId);
    const openaiPrompt = `Create a cinematic description of this interior scene for video animation. 
Use natural movement only — such as light flicker, curtain sway, tree motion, or shifting shadows.
Camera movement should follow this instruction: "${cameraControl}". 
Do not alter the structure of the space. Maintain realism and elegance.`;
    console.log("📝 Sending prompt to OpenAI...");
    let prompt = "A cinematic scene.";
    try {
      const openaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "gpt-4-vision-preview",
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: openaiPrompt
                },
                {
                  type: "image_url",
                  image_url: {
                    url: signedSmallImageUrl
                  }
                }
              ]
            }
          ],
          max_tokens: 150
        })
      });
      if (!openaiRes.ok) {
        const text = await openaiRes.text();
        console.error("❌ OpenAI error:", text);
        throw new Error(`OpenAI error: ${text}`);
      }
      const openaiData = await openaiRes.json();
      prompt = openaiData?.choices?.[0]?.message?.content?.trim() || prompt;
      console.log("🎬 OpenAI returned prompt:", prompt);
    } catch (err) {
      console.error("⚠️ OpenAI fallback used:", err.message);
    }
    const replicateInitRes = await fetch("https://api.replicate.com/v1/models/kwaivgi/kling-v1.6-standard/predictions", {
      method: "POST",
      headers: {
        Authorization: `Token ${REPLICATE_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        input: {
          start_image: imageUrl ?? signedSmallImageUrl,
          prompt,
          duration: videoDuration
        }
      })
    });
    const replicateInitData = await replicateInitRes.json();
    const predictionId = replicateInitData.id;
    await supabase.from("jobs").update({
      prompt,
      replicate_prediction_id: predictionId,
      status: "generating",
      updated_at: new Date().toISOString()
    }).eq("id", jobId);
    let videoUrl = null;
    for(let i = 0; i < 32; i++){
      await new Promise((r)=>setTimeout(r, 6000));
      const pollRes = await fetch(`https://api.replicate.com/v1/predictions/${predictionId}`, {
        headers: {
          Authorization: `Token ${REPLICATE_API_KEY}`,
          "Content-Type": "application/json"
        }
      });
      const pollData = await pollRes.json();
      if (pollData.status === "succeeded") {
        videoUrl = pollData.output;
        break;
      }
      if (pollData.status === "failed" || pollData.status === "canceled") {
        await supabase.from("jobs").update({
          status: "error",
          updated_at: new Date().toISOString()
        }).eq("id", jobId);
        throw new Error(`Replicate failed: ${pollData.status}`);
      }
    }
    if (!videoUrl) {
      throw new Error("Video not ready after polling");
    }
    await supabase.from("jobs").update({
      video_url: videoUrl,
      status: "done",
      updated_at: new Date().toISOString()
    }).eq("id", jobId);
    console.log("✅ Video ready:", videoUrl);
    return new Response(JSON.stringify({
      success: true,
      videoUrl
    }), {
      status: 200,
      headers: corsHeaders
    });
  } catch (err) {
    console.error("❌ Outer Error:", err);
    return new Response(JSON.stringify({
      error: err?.message ?? "Unhandled server error"
    }), {
      status: 500,
      headers: corsHeaders
    });
  }
}, {
  cors: {
    origin: [
      "*"
    ],
    methods: [
      "GET",
      "POST",
      "OPTIONS"
    ],
    allowedHeaders: [
      "Content-Type",
      "Authorization"
    ]
  }
});
