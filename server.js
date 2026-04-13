import express from 'express';
import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { v2 } from '@google-cloud/speech';
import crypto from 'crypto';

config();

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3004;
const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT;

const LOCATION = process.env.GOOGLE_CLOUD_LOCATION || 'us';
const apiEndpoint = LOCATION === 'global'
  ? 'speech.googleapis.com'
  : `${LOCATION}-speech.googleapis.com`;
const speechClientOptions = { apiEndpoint };
if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  speechClientOptions.credentials = {
    client_email: credentials.client_email,
    private_key: credentials.private_key,
  };
  speechClientOptions.projectId = credentials.project_id;
}
const speechClient = new v2.SpeechClient(speechClientOptions);

const sessions = new Map();

app.use(express.static(__dirname));

app.get('/api/token', (req, res) => {
  const token = crypto.randomUUID();
  sessions.set(token, { created: Date.now() });
  setTimeout(() => sessions.delete(token), 60_000);
  res.json({ token });
});

const server = createServer(app);

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  if (url.pathname !== '/ws') {
    socket.destroy();
    return;
  }

  const token = url.searchParams.get('token');
  if (!token || !sessions.has(token)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  sessions.delete(token);

  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});

wss.on('connection', (ws) => {
  let recognizeStream = null;
  let streamStartedAt = null;

  function cleanup() {
    if (recognizeStream) {
      try { recognizeStream.end(); } catch {}
      recognizeStream = null;
    }
    streamStartedAt = null;
  }

  try {
    recognizeStream = speechClient._streamingRecognize();

    recognizeStream.on('data', (response) => {
      if (!response.results || response.results.length === 0) return;

      for (const result of response.results) {
        if (!result.alternatives || result.alternatives.length === 0) continue;

        const alt = result.alternatives[0];
        ws.send(JSON.stringify({
          type: 'transcript',
          text: alt.transcript,
          isFinal: result.isFinal,
          confidence: alt.confidence,
          resultEndOffset: result.resultEndOffset,
          stability: result.stability,
          languageCode: result.languageCode,
        }));
      }
    });

    recognizeStream.on('error', (err) => {
      console.error('gRPC stream error:', err.message);
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'error', message: err.message }));
      }
      cleanup();
    });

    recognizeStream.on('end', () => {
      cleanup();
    });

    const model = process.env.GOOGLE_CLOUD_STT_MODEL || 'chirp_3';

    const configRequest = {
      recognizer: `projects/${PROJECT_ID}/locations/${LOCATION}/recognizers/_`,
      streamingConfig: {
        config: {
          explicitDecodingConfig: {
            encoding: 'LINEAR16',
            sampleRateHertz: 16000,
            audioChannelCount: 1,
          },
          languageCodes: ['auto'],
          model,
        },
        streamingFeatures: {
          interimResults: true,
        },
      },
    };

    recognizeStream.write(configRequest);
    streamStartedAt = Date.now();

    ws.send(JSON.stringify({ type: 'session_started', model, streamStartedAt }));

  } catch (err) {
    console.error('Failed to create gRPC stream:', err.message);
    ws.send(JSON.stringify({ type: 'error', message: err.message }));
    ws.close();
    return;
  }

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'audio' && recognizeStream) {
      const audioBuffer = Buffer.from(msg.data, 'base64');
      try {
        recognizeStream.write({ audio: audioBuffer });
      } catch (err) {
        console.error('Error writing audio to gRPC:', err.message);
      }
    } else if (msg.type === 'stop') {
      cleanup();
      ws.close(1000);
    }
  });

  ws.on('close', () => {
    cleanup();
  });

  ws.on('error', () => {
    cleanup();
  });
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log(`  Project: ${PROJECT_ID}`);
  console.log(`  Location: ${LOCATION}`);
  console.log(`  Endpoint: ${apiEndpoint}`);
});
