const express = require("express");
const cors = require("cors");
const path = require("path");
const { MsEdgeTTS, OUTPUT_FORMAT } = require("msedge-tts");

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "30mb" }));
app.use(express.static(path.join(__dirname, "public")));

// 1. Edge TTS API
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

// 2. Story Generator API (Gemini 3.8 Flash)
app.post("/api/generate-story", async (req, res) => {
  try {
    const { topic, category, duration, episodes, visualStyle } = req.body;

    let targetScenes = 12;
    if (duration === "3min") targetScenes = 18;
    if (duration === "5min") targetScenes = 30;
    if (category === "series") {
      const epNum = parseInt(episodes) || 2;
      targetScenes = epNum * 12;
    }

    const promptSystem = `
You are a professional Myanmar Storyteller & Film Scriptwriter.
Task: Write a script based on:
- Topic: "${topic}"
- Category: "${category}"
- Art Style: "${visualStyle}"
- Total 10-Second Scenes: Exactly ${targetScenes} scenes.

RULES:
1. Each scene represents approximately 10 seconds of Myanmar speech (around 18-25 Burmese words).
2. "myanmar_text": High-grade natural Myanmar Unicode storytelling script.
3. "english_prompt": Highly detailed English AI image prompt including lighting, camera angle, and the chosen style.
4. Output strictly valid JSON object.

Format:
{
  "scenes": [
    {
      "segment": 1,
      "time_range": "00:00 - 00:10",
      "myanmar_text": "မြန်မာစာသား...",
      "english_prompt": "cinematic prompt in English..."
    }
  ]
}
`;

    const geminiKey = process.env.GEMINI_API_KEY ? process.env.GEMINI_API_KEY.trim() : "";
    let rawJsonText = "";

    if (geminiKey) {
      try {
        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${geminiKey}`;
        const geminiRes = await fetch(geminiUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: promptSystem }] }],
            generationConfig: {
              temperature: 0.7,
              responseMimeType: "application/json"
            }
          }),
        });

        const gData = await geminiRes.json();
        if (gData.candidates && gData.candidates[0]?.content?.parts?.[0]?.text) {
          rawJsonText = gData.candidates[0].content.parts[0].text;
        }
      } catch (e) {
        console.error("Gemini Error:", e);
      }
    }

    if (!rawJsonText) {
      return res.status(500).json({ error: "Gemini AI Script Generation Failed. Check GEMINI_API_KEY." });
    }

    const cleanText = rawJsonText.replace(/```json/gi, "").replace(/```/g, "").trim();
    const parsed = JSON.parse(cleanText);
    const scenes = Array.isArray(parsed) ? parsed : (parsed.scenes || Object.values(parsed)[0]);

    res.json({ success: true, scenes });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 3. AI Image Generation API (Dual-Engine: Turbo + Fallback)
app.post("/api/generate-image", async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: "Prompt is required" });

    const cleanPrompt = encodeURIComponent(prompt.trim().slice(0, 400));
    const seed = Math.floor(Math.random() * 9999999);

    // Multi-engine attempts
    const engines = [
      `https://image.pollinations.ai/prompt/${cleanPrompt}?width=1280&height=720&model=turbo&nologo=true&seed=${seed}`,
      `https://image.pollinations.ai/prompt/${cleanPrompt}?width=1280&height=720&nologo=true&seed=${seed}`
    ];

    for (const url of engines) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 18000);

        const imgRes = await fetch(url, { signal: controller.signal });
        clearTimeout(timeoutId);

        if (imgRes.ok) {
          const buffer = await imgRes.arrayBuffer();
          const base64 = Buffer.from(buffer).toString("base64");
          return res.json({ imageUrl: `data:image/jpeg;base64,${base64}` });
        }
      } catch (err) {
        // Try fallback
      }
    }

    res.status(500).json({ error: "Image generation engine failed." });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Routes
app.get("/mmvoice", (req, res) => res.sendFile(path.join(__dirname, "public", "mmvoice.html")));
app.get("/storycreate", (req, res) => res.sendFile(path.join(__dirname, "public", "storycreate.html")));
app.get("/storytovideo", (req, res) => res.sendFile(path.join(__dirname, "public", "storytovideo.html")));
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(port, () => console.log(`Server listening on port ${port}`));
