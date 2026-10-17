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
// 2. 10s Scene Story Generator API (Error-Free)
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
You are a professional Myanmar Storyteller & Film Director.
Write a script based on:
- Topic: "${topic}"
- Category: "${category}"
- Art Style: "${visualStyle || "Traditional Myanmar cultural art style, ancient Bagan royal aesthetic, ornate details"}"
- Total 10-Second Scenes: Exactly ${targetScenes} scenes.

RULES:
1. Each scene must be approximately 10 seconds of Myanmar speech (18-25 Burmese words).
2. "myanmar_text" must be high quality Myanmar Unicode storytelling script.
3. "english_prompt" must be a descriptive AI image prompt in English specifying lighting, camera view, and the chosen art style.
4. Respond with a single JSON object containing a "scenes" array.

Output format strictly like:
{
  "scenes": [
    {
      "segment": 1,
      "time_range": "00:00 - 00:10",
      "myanmar_text": "မြန်မာစာသား...",
      "english_prompt": "English cinematic prompt..."
    }
  ]
}
`;

    let rawJsonText = "";
    let lastError = "";

    // 1. Google Gemini API စမ်းသပ်ခြင်း
    if (process.env.GEMINI_API_KEY) {
      try {
        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`;
        const geminiRes = await fetch(geminiUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: promptSystem }] }],
            generationConfig: { responseMimeType: "application/json" },
          }),
        });
        const gData = await geminiRes.json();
        if (gData.candidates && gData.candidates[0]?.content?.parts?.[0]?.text) {
          rawJsonText = gData.candidates[0].content.parts[0].text;
        } else if (gData.error) {
          lastError = `Gemini: ${gData.error.message}`;
        }
      } catch (e) {
        lastError = `Gemini Exception: ${e.message}`;
      }
    }

    // 2. Groq API Fallback (Gemini အဆင်မပြေပါက အလိုအလျောက် သုံးမည်)
    if (!rawJsonText && process.env.GROQ_API_KEY) {
      try {
        const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
          },
          body: JSON.stringify({
            model: "llama-3.3-70b-versatile",
            messages: [
              { role: "system", content: "You output strictly JSON object format." },
              { role: "user", content: promptSystem }
            ],
            response_format: { type: "json_object" }
          }),
        });
        const qData = await groqRes.json();
        if (qData.choices && qData.choices[0]?.message?.content) {
          rawJsonText = qData.choices[0].message.content;
        } else if (qData.error) {
          lastError = `Groq: ${qData.error.message}`;
        }
      } catch (e) {
        lastError = `Groq Exception: ${e.message}`;
      }
    }

    if (!rawJsonText) {
      return res.status(500).json({ 
        error: `AI Error: ${lastError || "API Keys စစ်ဆေးပေးပါ (Gemini သို့မဟုတ် Groq)"}` 
      });
    }

    // Clean Markdown and Parse
    const cleanText = rawJsonText.replace(/```json/gi, "").replace(/```/g, "").trim();
    let parsed = JSON.parse(cleanText);
    let scenes = Array.isArray(parsed) ? parsed : (parsed.scenes || Object.values(parsed)[0]);

    res.json({ success: true, scenes });
  } catch (error) {
    console.error("Story API Error:", error);
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
        console.error("HF Error:", e);
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

    res.status(500).json({ error: "Image generation failed. Please check HuggingFace/Replicate token." });
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
