// Vonage session plus the audio mixing that feeds Gemini.
//
// The mixing is the part worth reading. Gemini needs to hear the whole room as
// one conversation, not four separate streams, otherwise it cannot follow who
// is answering whom. So the host subscribes to everyone, merges every inbound
// track plus its own mic into a single node, and ships 16kHz mono PCM up.

const API = import.meta.env.VITE_API || "ws://localhost:8000/ws";

export function connectBackend(onMessage) {
  const ws = new WebSocket(API);
  ws.onmessage = (e) => onMessage(JSON.parse(e.data));
  ws.onclose = () => setTimeout(() => connectBackend(onMessage), 1500);
  return ws;
}

// --------------------------------------------------------------------
// SEAM 3: Vonage
// Everything below joinRoom() is SDK-agnostic. It only needs a MediaStream
// per participant, however you obtain it.
// --------------------------------------------------------------------

export async function joinRoom({ apiKey, sessionId, token, onStream, publisherEl, subscriberEl }) {
  const OT = window.OT;
  if (!OT) throw new Error("Vonage SDK not loaded");

  const session = OT.initSession(apiKey, sessionId);

  session.on("streamCreated", (event) => {
    const subscriber = session.subscribe(event.stream, subscriberEl, {
      insertMode: "append",
      width: "100%",
      height: "100%",
    });
    // Give the mixer this participant's audio once it is flowing.
    subscriber.on("videoElementCreated", (e) => {
      const stream = e.element.srcObject;
      if (stream) onStream(stream);
    });
  });

  await new Promise((resolve, reject) => {
    session.connect(token, (err) => (err ? reject(err) : resolve()));
  });

  const publisher = OT.initPublisher(publisherEl, {
    insertMode: "append",
    width: "100%",
    height: "100%",
  });
  session.publish(publisher);

  const local = await navigator.mediaDevices.getUserMedia({ audio: true });
  onStream(local);

  return session;
}

// --------------------------------------------------------------------
// Audio mixing. Plain Web Audio, no dependencies, works today.
// --------------------------------------------------------------------

export function createMixer(ws) {
  // Asking for 16kHz directly avoids writing a resampler. Browsers honour this
  // in practice; if one does not, the model still understands the audio, it
  // just sounds slightly off pitch.
  const ctx = new AudioContext({ sampleRate: 16000 });
  const merger = ctx.createGain();

  // ScriptProcessor is deprecated but it is four lines and it works in every
  // browser you will meet tomorrow. Move to an AudioWorklet after the demo.
  const processor = ctx.createScriptProcessor(4096, 1, 1);

  processor.onaudioprocess = (e) => {
    if (ws.readyState !== WebSocket.OPEN) return;

    const input = e.inputBuffer.getChannelData(0);
    const pcm = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i]));
      pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }

    ws.send(JSON.stringify({
      type: "audio",
      pcm: btoa(String.fromCharCode(...new Uint8Array(pcm.buffer))),
    }));
  };

  merger.connect(processor);
  // Connecting to destination would echo the room back into the room. A muted
  // gain node keeps the processor pulling without anyone hearing themselves.
  const silent = ctx.createGain();
  silent.gain.value = 0;
  processor.connect(silent);
  silent.connect(ctx.destination);

  return {
    addStream(stream) {
      if (!stream.getAudioTracks().length) return;
      ctx.createMediaStreamSource(stream).connect(merger);
    },
    resume: () => ctx.resume(),
  };
}
