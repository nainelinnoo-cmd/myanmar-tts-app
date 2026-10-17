const express = require("express");
const cors = require("cors");
const path = require("path");
const { MsEdgeTTS, OUTPUT_FORMAT } = require("msedge-tts");

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "15mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ==========================================
// 1. Text-to-Speech API (Edge TTS)
// ==========================================
app.post("/api/tts", async (req, res) => {
  try {
    const { text, voice, rate, pitch } = req.body;
    if (!text || !text.trim()) {
      return res.status(400).json({ error: "Text is required" });
    }

    const tts = new MsEdgeTTS();
    await tts.setMetadata(
      voice || "my-MM-NilarNeural",
      OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3
    );

    const result = tts.toStream(text.trim(), {
      rate: rate || "+0%",
      pitch: pitch || "+0Hz",
    });

    const audioStream = result.audioStream || result;
    const chunks = [];

    audioStream.on("data", (chunk) => chunks.push(chunk));
    audioStream.on("end", () => {
      res.setHeader("Content-Type", "audio/mpeg");
      res.setHeader("Content-Disposition", 'inline; filename="speech.mp3"');
      res.send(Buffer.concat(chunks));
    });
    audioStream.on("error", (err) => {
      res.status(500).json({ error: err.message || "Synthesis failed" });
    });
  } catch (error) {
    res.status(500).json({ error: error.message || "Internal server error" });
  }
});

// ==========================================
// 2. 10s Scene Auto-Split Story Generator API
// ==========================================
app.post("/api/generate-story", async (req, res) => {
  try {
    const { topic, category, duration, episodes, visualStyle } = req.body;

    let targetScenes = 12; // 2 mins = 12 scenes
    if (duration === "3min") targetScenes = 18;
    if (duration === "5min") targetScenes = 30;
    if (category === "series") {
      const epNum = parseInt(episodes) || 2;
      targetScenes = epNum * 12;
    }

    const promptSystem = `
You are a professional Myanmar Storyteller & Film Scriptwriter.
Task: Write a captivating story/recap based on:
- Topic/Title: "${topic}"
- Category: "${category}" (Story, Movie Recap, or Series)
- Visual Art Style: "${visualStyle || "Cinematic 3D Animation, Pixar & Unreal Engine style"}"
- Required Total 10-Second Scenes: Exactly ${targetScenes} scenes.

STRICT RULES:
1. Each scene represents EXACTLY 10 seconds of Myanmar speech (approx 18 to 25 Myanmar words).
2. For each scene, you must provide:
   - "time_range": timestamp label like "00:00 - 00:10", "00:10 - 00:20"
   - "myanmar_text": Engaging, natural, storytelling Myanmar Unicode script.
   - "english_prompt": Highly detailed image/video generation prompt in English including art style, lighting, camera angle, and character description.
3. OUTPUT FORMAT: Respond ONLY with valid JSON array of objects. Do not write markdown ticks (\`\`\`json).
`;

    let rawJsonText = "";

    // 1st Priority: Google Gemini API
    if (process.env.GEMINI_API_KEY) {
      try {
        const geminiRes = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{ parts: [{ text: promptSystem }] }],
              generationConfig: { responseMimeType: "application/json" },
            }),
          }
        );
        const geminiData = await geminiRes.json();
        rawJsonText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text;
      } catch (err) {
        console.error("Gemini Error, trying Groq fallback...", err);
      }
    }

    // 2nd Priority: Groq Fallback
    if (!rawJsonText && process.env.GROQ_API_KEY) {
      const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        },
        body: JSON.stringify({
          model: "llama-3.3-70b-versatile",
          messages: [
            { role: "system", content: "You output only clean JSON." },
            { role: "user", content: promptSystem },
          ],
          response_format: { type: "json_object" },
        }),
      });
      const groqData = await groqRes.json();
      rawJsonText = groqData.choices?.[0]?.message?.content;
    }

    if (!rawJsonText) {
      return res.status(500).json({ error: "Failed to generate story from AI." });
    }

    let scenes = JSON.parse(rawJsonText);
    if (!Array.isArray(scenes) && scenes.scenes) scenes = scenes.scenes;

    res.json({ success: true, scenes });
  } catch (error) {
    console.error("Story Gen Error:", error);
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// 3. AI Image Generation API
// ==========================================
app.post("/api/generate-image", async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: "Prompt is required" });

    // Hugging Face FLUX
    if (process.env.HF_TOKEN) {
      try {
        const hfRes = await fetch(
          "https://api-inference.huggingface.co/models/black-forest-labs/FLUX.1-schnell",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${process.env.HF_TOKEN}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ inputs: prompt }),
          }
        );

        if (hfRes.ok) {
          const buffer = await hfRes.arrayBuffer();
          const base64 = Buffer.from(buffer).toString("base64");
          return res.json({ imageUrl: `data:image/jpeg;base64,${base64}` });
        }
      } catch (e) {
        console.error("HF Error, checking Replicate...", e);
      }
    }

    // Replicate Fallback
    if (process.env.REPLICATE_API_TOKEN) {
      const repRes = await fetch("https://api.replicate.com/v1/models/black-forest-labs/flux-schnell/predictions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.REPLICATE_API_TOKEN}`,
          "Content-Type": "application/json",
          Prefer: "wait",
        },
        body: JSON.stringify({ input: { prompt: prompt, num_outputs: 1 } }),
      });
      const repData = await repRes.json();
      if (repData.output && repData.output[0]) {
        return res.json({ imageUrl: repData.output[0] });
      }
    }

    res.status(500).json({ error: "Image generation failed. Please check tokens." });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// 4. Clean URL Routes (အသစ်ပြင်ဆင်ထားသော အပိုင်း)
// ==========================================
app.get("/mmvoice", (req, res) => res.sendFile(path.join(__dirname, "public", "mmvoice.html")));
app.get("/storycreate", (req, res) => res.sendFile(path.join(__dirname, "public", "storycreate.html")));
app.get("/storytovideo", (req, res) => res.sendFile(path.join(__dirname, "public", "storytovideo.html")));

// Default Fallback
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(port, () => console.log(`Server listening on port ${port}`));
