export default {
  async fetch(request, env, ctx) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);
    if (url.pathname === "/" && request.method === "GET") {
      return new Response("Myanmar Edge TTS Worker is Running!", {
        headers: { "Content-Type": "text/plain", ...corsHeaders },
      });
    }

    if (url.pathname !== "/api/tts" || request.method !== "POST") {
      return new Response("Not Found", { status: 404, headers: corsHeaders });
    }

    try {
      const body = await request.json();
      const text = body.text ? body.text.trim() : "";
      const voice = body.voice || "my-MM-NilarNeural";
      const rate = body.rate || "+0%";
      const pitch = body.pitch || "+0Hz";

      if (!text) {
        return new Response(JSON.stringify({ error: "Text is required" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      const cleanText = text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");

      const audioBuffer = await generateEdgeTTS(cleanText, voice, rate, pitch);

      return new Response(audioBuffer, {
        headers: {
          "Content-Type": "audio/mpeg",
          "Content-Disposition": 'inline; filename="speech.mp3"',
          "Cache-Control": "no-cache",
          ...corsHeaders,
        },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message || err.toString() }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }
  },
};

async function getSecMsGec() {
  const TRUSTED_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
  const unixSeconds = BigInt(Math.floor(Date.now() / 1000));
  const fileTime = (unixSeconds + 11644473600n) * 10000000n;
  const roundedTicks = fileTime - (fileTime % 3000000000n);

  const data = new TextEncoder().encode(roundedTicks.toString() + TRUSTED_TOKEN);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}

async function generateEdgeTTS(text, voice, rate, pitch) {
  const TRUSTED_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
  const EDGE_VERSION = "131.0.2903.86";
  const EDGE_MAJOR = "131";
  const secMsGec = await getSecMsGec();
  const connectionId = crypto.randomUUID().replace(/-/g, "");

  const wsUrl = `https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${TRUSTED_TOKEN}&Sec-MS-GEC=${secMsGec}&Sec-MS-GEC-Version=1-${EDGE_VERSION}&ConnectionId=${connectionId}`;

  const resp = await fetch(wsUrl, {
    headers: {
      "Pragma": "no-cache",
      "Cache-Control": "no-cache",
      "User-Agent": `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${EDGE_MAJOR}.0.0.0 Safari/537.36 Edg/${EDGE_MAJOR}.0.0.0`,
      "Origin": "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
      "Upgrade": "websocket",
      "Sec-WebSocket-Version": "13",
      "Sec-WebSocket-Key": crypto.randomUUID().slice(0, 16),
      "Accept-Encoding": "gzip, deflate, br",
      "Accept-Language": "en-US,en;q=0.9",
    },
  });

  const ws = resp.webSocket;
  if (!ws) {
    throw new Error(`Edge TTS WebSocket handshake failed (HTTP ${resp.status})`);
  }
  ws.accept();

  return new Promise((resolve, reject) => {
    const audioChunks = [];
    const requestId = crypto.randomUUID().replace(/-/g, "");
    const timestamp = new Date().toString();

    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error("Edge TTS Request Timeout"));
    }, 20000);

    ws.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        if (event.data.includes("Path:turn.end")) {
          clearTimeout(timeout);
          ws.close();

          const totalLength = audioChunks.reduce((acc, c) => acc + c.byteLength, 0);
          if (totalLength === 0) {
            reject(new Error("အသံဒေတာ မရရှိပါ"));
            return;
          }
          const completeAudio = new Uint8Array(totalLength);
          let offset = 0;
          for (const chunk of audioChunks) {
            completeAudio.set(new Uint8Array(chunk), offset);
            offset += chunk.byteLength;
          }
          resolve(completeAudio.buffer);
        }
      } else if (event.data instanceof ArrayBuffer) {
        const view = new DataView(event.data);
        if (view.byteLength > 2) {
          const headerLength = view.getInt16(0);
          if (view.byteLength > headerLength + 2) {
            const rawAudio = event.data.slice(headerLength + 2);
            audioChunks.push(rawAudio);
          }
        }
      }
    });

    ws.addEventListener("close", () => {
      clearTimeout(timeout);
      if (audioChunks.length === 0) {
        reject(new Error("Edge TTS connection closed before audio was received"));
      }
    });

    ws.addEventListener("error", (err) => {
      clearTimeout(timeout);
      reject(new Error("WebSocket Error: " + (err.message || "Unknown error")));
    });

    const configMessage =
      `X-Timestamp:${timestamp}\r\n` +
      `Content-Type:application/json; charset=utf-8\r\n` +
      `Path:speech.config\r\n\r\n` +
      JSON.stringify({
        context: {
          synthesis: {
            audio: {
              metadataoptions: {
                sentenceBoundaryEnabled: "false",
                wordBoundaryEnabled: "false",
              },
              outputFormat: "audio-24khz-48kbitrate-mono-mp3",
            },
          },
        },
      });
    ws.send(configMessage);

    const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US"><voice name="${voice}"><prosody rate="${rate}" pitch="${pitch}">${text}</prosody></voice></speak>`;
    const ssmlMessage =
      `X-RequestId:${requestId}\r\n` +
      `Content-Type:application/ssml+xml\r\n` +
      `X-Timestamp:${timestamp}\r\n` +
      `Path:ssml\r\n\r\n` +
      ssml;

    ws.send(ssmlMessage);
  });
}
