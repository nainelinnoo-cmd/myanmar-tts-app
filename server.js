const express = require("express");
const cors = require("cors");
const path = require("path");
const { MsEdgeTTS, OUTPUT_FORMAT } = require("msedge-tts");

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "15mb" }));
app.use(express.static(path.join(__dirname, "public")));

// 1. Text-to-Speech API
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

// Helper: Gemini API Key စစ်ပြီး လက်ရှိသုံးနိုင်သော Update Model ရှာပေးသည့် Function
async function getActiveGeminiModel(apiKey) {
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
    const data = await res.json();
    if (data.models && Array.isArray(data.models)) {
      // generateContent ထောက်ပံ့ပြီး flash သို့မဟုတ် pro ပါသော model ကို ရှာဖွေခြင်း
      const supported = data.models.filter(m => 
        m.supportedGenerationMethods && 
        m.supportedGenerationMethods.includes("generateContent")
      );
      
      // Flash model ဦးစားပေး ရွေးချယ်ခြင်း
      const flashModel = supported.find(m => m.name.includes("flash") && !m.name.includes("1.5"));
      if (flashModel) return flashModel.name.replace("models/", "");

      if (supported.length > 0) return supported[0].name.replace("models/", "");
    }
  } catch (e) {
    console.error("Gemini ListModels Error:", e);
  }
  return "gemini-2.0-flash"; // Fallback default
}

// 2. 10s Scene Story Generator API (Gemini Dynamic Model Auto-Detect)
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
Task: Write a script based on:
- Topic: "${topic}"
- Category: "${category}"
- Art Style: "${visualStyle}"
- Total 10-Second Scenes: Exactly ${targetScenes} scenes.

RULES:
1. Each scene represents 10 seconds of Myanmar speech (approx 18 to 25 words).
2. "myanmar_text": Engaging Myanmar Unicode storytelling script.
3. "english_prompt": Highly detailed English AI image prompt including lighting, camera angle, and the chosen style.
4. Output strictly valid JSON object.

Format strictly:
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
    const groqKey = process.env.GROQ_API_KEY ? process.env.GROQ_API_KEY.trim() : "";

    let rawJsonText = "";
    let errorLogs = [];

    // 1st Priority: Gemini with Auto-Detected Latest Model
    if (geminiKey) {
      try {
        const activeModel = await getActiveGeminiModel(geminiKey);
        console.log("Using Gemini Active Model:", activeModel);

        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${activeModel}:generateContent?key=${geminiKey}`;
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
          errorLogs.push(`Gemini (${activeModel}): ${gData.error.message}`);
        }
      } catch (e) {
        errorLogs.push(`Gemini Exception: ${e.message}`);
      }
    } else {
      errorLogs.push("GEMINI_API_KEY မရှိပါ");
    }

    // 2nd Priority: Groq (Llama 3.1 Latest / Mixtral Model)
    if (!rawJsonText && groqKey) {
      const groqModels = ["llama-3.1-8b-instant", "llama3-70b-8192", "mixtral-8x7b-32768"];
      for (const gModel of groqModels) {
        try {
          const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${groqKey}`,
            },
            body: JSON.stringify({
              model: gModel,
              messages: [
                { role: "system", content: "You output strictly valid JSON object." },
                { role: "user", content: promptSystem }
              ],
              response_format: { type: "json_object" }
            }),
          });
          const qData = await groqRes.json();
          if (qData.choices && qData.choices[0]?.message?.content) {
            rawJsonText = qData.choices[0].message.content;
            break;
          }
        } catch (err) {
          // try next model
        }
      }
    }

    if (!rawJsonText) {
      return res.status(500).json({ error: errorLogs.join(" | ") || "AI generation failed." });
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

// 3. AI Image Generation API
app.post("/api/generate-image", async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: "Prompt is required" });

    const hfToken = process.env.HF_TOKEN ? process.env.HF_TOKEN.trim() : "";
    const repToken = process.env.REPLICATE_API_TOKEN ? process.env.REPLICATE_API_TOKEN.trim() : "";

    if (hfToken) {
      try {
        const hfRes = await fetch(
          "https://api-inference.huggingface.co/models/black-forest-labs/FLUX.1-schnell",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${hfToken}`,
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

    if (repToken) {
      const repRes = await fetch("https://api.replicate.com/v1/models/black-forest-labs/flux-schnell/predictions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${repToken}`,
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

// Routes
app.get("/mmvoice", (req, res) => res.sendFile(path.join(__dirname, "public", "mmvoice.html")));
app.get("/storycreate", (req, res) => res.sendFile(path.join(__dirname, "public", "storycreate.html")));
app.get("/storytovideo", (req, res) => res.sendFile(path.join(__dirname, "public", "storytovideo.html")));
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(port, () => console.log(`Server listening on port ${port}`));
