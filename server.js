const express = require("express");
const cors = require("cors");
const path = require("path");
const { MsEdgeTTS, OUTPUT_FORMAT } = require("msedge-tts");

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// UI Frontend ဖိုင်များကို တိုက်ရိုက် လွှင့်တင်ခြင်း
app.use(express.static(path.join(__dirname, "public")));

// Text-to-Speech API
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

    // msedge-tts v2 stream handling
    const result = tts.toStream(text.trim(), {
      rate: rate || "+0%",
      pitch: pitch || "+0Hz",
    });

    const audioStream = result.audioStream || result;
    const chunks = [];

    audioStream.on("data", (chunk) => {
      chunks.push(chunk);
    });

    audioStream.on("end", () => {
      const audioBuffer = Buffer.concat(chunks);
      res.setHeader("Content-Type", "audio/mpeg");
      res.setHeader("Content-Disposition", 'inline; filename="myanmar-speech.mp3"');
      res.send(audioBuffer);
    });

    audioStream.on("error", (err) => {
      console.error("Stream Error:", err);
      res.status(500).json({ error: err.message || "Synthesis failed" });
    });
  } catch (error) {
    console.error("Server Error:", error);
    res.status(500).json({ error: error.message || "Internal server error" });
  }
});

// မည်သည့် route သို့မဆို UI သို့ ပို့ပေးခြင်း
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
