const express = require("express");
const cors = require("cors");
const path = require("path");
const { MsEdgeTTS, OUTPUT_FORMAT } = require("msedge-tts");

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "35mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ==========================================
// 1. Text-to-Speech API (Edge TTS with Boost)
// ==========================================
app.post("/api/tts", async (req, res) => {
  try {
    const { text, voice, rate, pitch, volume } = req.body;
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
      volume: volume || "+50%"
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
// 2. Story Generator API (Direct gemini-3.8-flash)
// ==========================================
app.post("/api/generate-story", async (req, res) => {
  try {
    const { topic, category, duration, episodes, type, visualStyle } = req.body;

    let targetScenes = 12;
    let totalEp = 1;

    if (type === "series") {
      totalEp = parseInt(episodes) || 3;
      targetScenes = totalEp * 12;
    } else {
      if (duration === "1min") targetScenes = 6;
      else if (duration === "3min") targetScenes = 18;
      else if (duration === "5min") targetScenes = 30;
      else targetScenes = 12;
    }

    const promptSystem = `
You are an expert Myanmar Film Director and Master Storyteller.
Task: Write a script based on:
- Topic: "${topic}"
- Format Type: "${type || "single"}" (Total Episodes: ${totalEp})
- Genre: "${category || "story"}"
- Art Style: "${visualStyle || "Cinematic film still, 8k resolution"}"
- Total 10-Second Scenes Needed: Exactly ${targetScenes} scenes.

CRITICAL INSTRUCTIONS:
1. Each scene MUST be suitable for a 10-second segment (around 18-25 words in Burmese).
2. "myanmar_text": Engaging, high-grade Myanmar Unicode narration script without markdown symbols.
3. "english_prompt": Highly descriptive English prompt for AI image generation mentioning style, lighting, and camera angle.
4. If format is series, assign "episode" number (1 to ${totalEp}) evenly across scenes.
5. Output strictly a valid JSON object matching the format below.

Output Format:
{
  "scenes": [
    {
      "episode": 1,
      "scene": 1,
      "time_range": "00:00 - 00:10",
      "myanmar_text": "မြန်မာဇာတ်ကြောင်းပြောစာသား...",
      "english_prompt": "Cinematic visual prompt in English..."
    }
  ]
}
`;

    const geminiKey = process.env.GEMINI_API_KEY ? process.env.GEMINI_API_KEY.trim() : "";
    let rawJsonText = "";
    let errorDetail = "";

    if (geminiKey) {
      try {
        // gemini-3.8-flash ကို တိုက်ရိုက် အသုံးပြုခြင်း
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
        } else if (gData.error) {
          errorDetail = `Gemini: ${gData.error.message}`;
        }
      } catch (e) {
        errorDetail = `Gemini Exception: ${e.message}`;
      }
    } else {
      errorDetail = "GEMINI_API_KEY is not configured in Environment";
    }

    if (!rawJsonText) {
      return res.status(500).json({ error: errorDetail || "Story generation failed." });
    }

    const cleanText = rawJsonText.replace(/```json/gi, "").replace(/```/g, "").trim();
    const parsed = JSON.parse(cleanText);
    const scenes = Array.isArray(parsed) ? parsed : (parsed.scenes || Object.values(parsed)[0]);

    res.json({ success: true, scenes });
  } catch (error) {
    console.error("Story API Error:", error);
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// 3. AI Image Generation API (Backup Fallback)
// ==========================================
app.post("/api/generate-image", async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: "Prompt is required" });

    const cleanPrompt = encodeURIComponent(prompt.trim().slice(0, 350));
    const seed = Math.floor(Math.random() * 9999999);
    const polUrl = `https://image.pollinations.ai/prompt/${cleanPrompt}?width=1280&height=720&model=flux&nologo=true&seed=${seed}`;

    const polRes = await fetch(polUrl);
    if (polRes.ok) {
      const buffer = await polRes.arrayBuffer();
      const base64 = Buffer.from(buffer).toString("base64");
      return res.json({ imageUrl: `data:image/jpeg;base64,${base64}` });
    }

    res.status(500).json({ error: "Image generation failed." });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Web Routes
app.get("/mmvoice", (req, res) => res.sendFile(path.join(__dirname, "public", "mmvoice.html")));
app.get("/storycreate", (req, res) => res.sendFile(path.join(__dirname, "public", "storycreate.html")));
app.get("/storytovideo", (req, res) => res.sendFile(path.join(__dirname, "public", "storytovideo.html")));
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(port, () => console.log(`Server listening on port ${port}`));
