import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  const REPLICATE_API_KEY = process.env.REPLICATE_API_KEY;

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  try {
    const { jobId, filename, smallImageBase64, imageUrl } = req.body || {};
    if (!jobId || !filename || !smallImageBase64) {
      console.error("❌ Missing jobId, filename, or smallImageBase64 in request body");
      return res.status(400).json({ error: "Missing jobId, filename, or smallImageBase64" });
    }

    console.log("▶️ Starting processing for jobId:", jobId);

    // 1. Upload small image
    const binary = Buffer.from(smallImageBase64, "base64");
    const smallPath = `jobs/${filename}`;
    const { error: uploadError } = await supabase
      .storage
      .from("uploads-small")
      .upload(smallPath, binary, { contentType: "image/jpeg", upsert: true });

    if (uploadError) {
      console.error("🛑 Upload failed:", uploadError.message);
      return res.status(500).json({ error: "Upload to Supabase failed" });
    }

    console.log("✅ Small image uploaded:", smallPath);

    // 2. Generate signed URL
    const { data: signedUrlData, error: signError } = await supabase
      .storage
      .from("uploads-small")
      .createSignedUrl(smallPath, 900);

    if (signError) {
      console.error("🛑 Signed URL generation failed:", signError.message);
      return res.status(500).json({ error: "Signed URL creation failed" });
    }

    const signedSmallImageUrl = signedUrlData?.signedUrl
      ? `${SUPABASE_URL}/storage/v1/${signedUrlData.signedUrl}`
      : null;

    if (!signedSmallImageUrl) {
      console.error("🛑 No signed small image URL generated.");
      return res.status(500).json({ error: "No signed image URL" });
    }

    console.log("🔗 Signed small image URL:", signedSmallImageUrl);

    // 3. Generate OpenAI prompt
    let prompt = "A cinematic scene.";
    try {
      console.log("🤖 Calling OpenAI...");
      const openaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-4-vision-preview",
          messages: [
            { role: "user", content: [
              { type: "text", text: "Create a cinematic description of this interior scene for video animation. Use natural movement only — light flicker, tree sway, shadow shift. No structure changes. Maintain realism." },
              { type: "image_url", image_url: { url: signedSmallImageUrl } }
            ] }
          ],
          max_tokens: 150,
        }),
      });

      if (!openaiRes.ok) {
        const openaiErrorText = await openaiRes.text();
        console.error("⚠️ OpenAI request failed:", openaiErrorText);
        throw new Error("OpenAI failed");
      }

      const openaiData = await openaiRes.json();
      prompt = openaiData?.choices?.[0]?.message?.content?.trim() || prompt;
      console.log("📝 OpenAI generated prompt:", prompt);

    } catch (error) {
      console.error("⚠️ Using fallback prompt due to OpenAI error:", error.message);
    }

    // 4. Start Replicate generation
    const finalImageUrl = imageUrl || signedSmallImageUrl;
    console.log("🎬 Sending image to Replicate:", finalImageUrl);

    const replicateRes = await fetch("https://api.replicate.com/v1/models/kwaivgi/kling-v1.6-standard/predictions", {
      method: "POST",
      headers: {
        "Authorization": `Token ${REPLICATE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        input: {
          start_image: finalImageUrl,
          prompt: prompt,
          duration: 5, // hardcoded for now
        }
      }),
    });

    if (!replicateRes.ok) {
      const replicateErrorText = await replicateRes.text();
      console.error("🛑 Replicate call failed:", replicateErrorText);
      return res.status(500).json({ error: "Replicate request failed" });
    }

    const replicateData = await replicateRes.json();
    const predictionId = replicateData?.id;

    console.log("🚀 Replicate prediction started, ID:", predictionId);

    if (!predictionId) {
      return res.status(500).json({ error: "No prediction ID returned from Replicate" });
    }

    // Optionally save the prediction ID into Supabase `jobs` table here if needed.

    return res.status(200).json({ success: true, predictionId });

  } catch (err) {
    console.error("❌ Fatal server error:", err.message);
    return res.status(500).json({ error: err.message || "Server error" });
  }
}
