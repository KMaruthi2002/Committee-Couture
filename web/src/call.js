// Backend socket plus a peer to peer video call.
//
// No third party video service. Signalling rides the websocket we already
// have per room, and the media goes directly between browsers over WebRTC.
// A public STUN server handles address discovery; on the same network, or on
// localhost, that is all you need.

const ICE = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ],
};

export function connectBackend(code, onMessage) {
  const base = import.meta.env.VITE_API || "ws://localhost:8000/ws";
  const ws = new WebSocket(`${base}/${encodeURIComponent(code)}`);
  ws.onmessage = (e) => onMessage(JSON.parse(e.data));
  return ws;
}

/**
 * Starts the call. Returns { stop, stream }.
 *
 * onRemote(stream)  fires when the other person's video arrives
 * onStatus(text)    "waiting" | "connecting" | "live" | "alone"
 */
export async function startCall(ws, { onLocal, onRemote, onStatus }) {
  let pc = null;
  let local = null;

  try {
    local = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 640, facingMode: "user" },
      audio: true,
    });
  } catch (err) {
    onStatus?.("nocam");
    throw err;
  }

  onLocal?.(local);
  onStatus?.("waiting");

  function fresh() {
    const conn = new RTCPeerConnection(ICE);
    local.getTracks().forEach((t) => conn.addTrack(t, local));

    conn.onicecandidate = (e) => {
      if (e.candidate) {
        send({ kind: "ice", candidate: e.candidate });
      }
    };

    conn.ontrack = (e) => {
      onRemote?.(e.streams[0]);
      onStatus?.("live");
    };

    conn.onconnectionstatechange = () => {
      if (conn.connectionState === "connected") onStatus?.("live");
      if (["disconnected", "failed", "closed"].includes(conn.connectionState)) {
        onStatus?.("waiting");
      }
    };

    return conn;
  }

  function send(payload) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "signal", ...payload }));
    }
  }

  async function makeOffer() {
    pc = fresh();
    onStatus?.("connecting");
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    send({ kind: "offer", sdp: pc.localDescription });
  }

  async function handle(msg) {
    if (msg.type === "peer-joined") {
      // We were here first, so we make the offer.
      await makeOffer();
      return;
    }

    if (msg.type === "peer-left") {
      pc?.close();
      pc = null;
      onRemote?.(null);
      onStatus?.("waiting");
      return;
    }

    if (msg.type !== "signal") return;

    if (msg.kind === "offer") {
      pc?.close();
      pc = fresh();
      onStatus?.("connecting");
      await pc.setRemoteDescription(msg.sdp);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      send({ kind: "answer", sdp: pc.localDescription });
    } else if (msg.kind === "answer" && pc) {
      await pc.setRemoteDescription(msg.sdp);
    } else if (msg.kind === "ice" && pc) {
      try {
        await pc.addIceCandidate(msg.candidate);
      } catch {
        /* candidates can arrive before the description; safe to drop */
      }
    }
  }

  return {
    handle,
    stream: local,
    stop() {
      pc?.close();
      local.getTracks().forEach((t) => t.stop());
    },
  };
}
