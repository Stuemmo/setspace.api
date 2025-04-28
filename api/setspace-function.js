import { createClient } from "@supabase/supabase-js";
import fetch from "node-fetch";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  // --- CORS HEADERS ---
  res.setHeader("Access-Control-Allow-Origin", "https://preview--prop-ai-cinema.lovable.app");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  // --- CONTINUE NORMAL LOGIC ---
  try {
    const { jobId, filename, smallImageBase64, imageUrl } = req.body;

    if (!jobId || !filename || !smallImageBase64) {
      throw new Error("Missing required fields");
    }

    console.log("Starting video generation for job:", jobId);

    // Upload small image to Supabase Storage
    const smallImageBuffer = Buffer.from(smallImageBase64, "base64");
    const { error: uploadError } = await supabase
      .storage
      .from("uploads-small")
      .upload(`jobs/${filename}`, smallImageBuffer, {
        contentType: "image/jpeg",
        upsert: true,
      });

    if (uploadError) {
      console.error("Upload failed:", uploadError.message);
      throw new Error(`Upload failed: ${uploadError.message}`);
    }

    console.log("Small image uploaded to uploads-small.");

    // Sign the uploaded small image URL
    const signRes = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/sign/uploads-small/jobs/${filename}`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ expiresIn: 900 }),
    });

    const { signedURL } = await signRes.json();
    const signedSmallImageUrl = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/${signedURL}`;

    console.log("Signed small image URL:", signedSmallImageUrl);

    // Update job in Supabase with small image URL
    await supabase.from("jobs").update({
      small_image_url: signedSmallImageUrl
    }).eq("id", jobId);

    console.log("Job updated with small image URL.");

    // Prepare payload for OpenAI
    const openaiPrompt = `Create a cinematic description of this interior scene for video animation. 
Use natural movement only — such as light flicker, curtain sway, tree motion, or shifting shadows.
Camera movement should follow this instruction: "zoom-in". 
Do not alter the structure of the space. Maintain realism and elegance.`;

    console.log("Calling OpenAI for cinematic prompt...");

    let prompt = "A cinematic scene.";
    try {
      const openaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-4-vision-preview",
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: openaiPrompt },
                { type: "image_url", image_url: { url: signedSmallImageUrl } },
              ],
            },
          ],
          max_tokens: 150,
        }),
      });

      if (openaiRes.ok) {
        const openaiData = await openaiRes.json();
        prompt = openaiData?.choices?.[0]?.message?.content?.trim() || prompt;
        console.log("Received cinematic prompt:", prompt);
      } else {
        const text = await openaiRes.text();
        console.error("OpenAI error fallback:", text);
      }
    } catch (err) {
      console.error("Error calling OpenAI:", err.message);
    }

    // Start Replicate video generation
    console.log("Calling Replicate API to start video generation...");

    const replicateRes = await fetch("https://api.replicate.com/v1/models/kwaivgi/kling-v1.6-standard/predictions", {
      method: "POST",
      headers: {
        Authorization: `Token ${process.env.REPLICATE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        input: {
          start_image: imageUrl ?? signedSmallImageUrl,
          prompt,
          duration: 5
        }
      }),
    });

    const replicateData = await replicateRes.json();
    const predictionId = replicateData.id;

    console.log("Replicate started, prediction ID:", predictionId);

    // Save prediction ID back to job
    await supabase.from("jobs").update({
      prompt,
      replicate_prediction_id: predictionId,
      status: "generating",
      updated_at: new Date().toISOString()
    }).eq("id", jobId);

    res.status(200).json({ success: true });
  } catch (err) {
    console.error("❌ Error in handler:", err.message);
    res.status(500).json({ error: err.message });
  }
}
