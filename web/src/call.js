// Backend socket plus the Vonage session and audio mixing.
//
// connectBackend now takes a room code, so two groups never share a look.

export function connectBackend(code, onMessage) {
  const base = import.meta.env.VITE_API || "ws://localhost:8000/ws";
  const ws = new WebSocket(`${base}/${encodeURIComponent(code)}`);
  ws.onmessage = (e) => onMessage(JSON.parse(e.data));
  return ws;
}

// --------------------------------------------------------------------
// Vonage. Everything below joinRoom is SDK-agnostic and only needs a
// MediaStream per participant.
// --------------------------------------------------------------------

export async function joinRoom({ apiKey, sessionId, token, onStream, publisherEl, subscriberEl }) {
  const OT = window.OT;
  if (!OT) throw new Error("Vonage SDK not loaded");

  const session = OT.initSession(apiKey, sessionId);

  session.on("streamCreated", (event) => {
    const subscriber = session.subscribe(event.stream, subscriberEl, {
      insertMode: "replace",
      width: "100%",
      height: "100%",
    });
    subscriber.on("videoElementCreated", (e) => {
      const stream = e.element.srcObject;
      if (stream) onStream(stream);
    });
  });

  await new Promise((resolve, reject) => {
    session.connect(token, (err) => (err ? reject(err) : resolve()));
  });

  const publisher = OT.initPublisher(publisherEl, {
    insertMode: "replace",
    width: "100%",
    height: "100%",
  });
  session.publish(publisher);

  const local = await navigator.mediaDevices.getUserMedia({ audio: true });
  onStream(local);

  return session;
}

// --------------------------------------------------------------------
// Audio mixing: the whole room as one stream, which is what Gemini needs
// in order to follow who is answering whom.
// --------------------------------------------------------------------

export function createMixer(ws) {
  const ctx = new AudioContext({ sampleRate: 16000 });
  const merger = ctx.createGain();
  const processor = ctx.createScriptProcessor(4096, 1, 1);

  processor.onaudioprocess = (e) => {
    if (ws.readyState !== WebSocket.OPEN) return;

    const input = e.inputBuffer.getChannelData(0);
    const pcm = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i]));
      pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }

    const bytes = new Uint8Array(pcm.buffer);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);

    ws.send(JSON.stringify({ type: "audio", pcm: btoa(binary) }));
  };

  merger.connect(processor);

  // A muted sink keeps the processor pulling without the room hearing itself.
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
