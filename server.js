const express = require("express");
const cors = require("cors");
const { MsEdgeTTS, OUTPUT_FORMAT } = require("msedge-tts");

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.send("Myanmar Edge TTS Server is Live & Running!");
});

app.post("/api/tts", async (req, res) => {
  try {
    const { text, voice, rate, pitch } = req.body;

    if (!text) {
      return res.status(400).json({ error: "Text is required" });
    }

    const tts = new MsEdgeTTS();
    await tts.setMetadata(
      voice || "my-MM-NilarNeural",
      OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3
    );

    // Speed & Pitch prosody formatting
    const readable = tts.toStream(text, {
      rate: rate || "+0%",
      pitch: pitch || "+0Hz",
    });

    const chunks = [];
    readable.on("data", (chunk) => {
      chunks.push(chunk);
    });

    readable.on("end", () => {
      const audioBuffer = Buffer.concat(chunks);
      res.setHeader("Content-Type", "audio/mpeg");
      res.setHeader("Content-Disposition", 'inline; filename="speech.mp3"');
      res.send(audioBuffer);
    });

    readable.on("error", (err) => {
      console.error("TTS Stream Error:", err);
      res.status(500).json({ error: err.message || "Synthesis failed" });
    });
  } catch (error) {
    console.error("Server Error:", error);
    res.status(500).json({ error: error.message || "Internal server error" });
  }
});

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
