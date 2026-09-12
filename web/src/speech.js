// Live speech, running alongside the WebRTC call.
//
// Each browser listens to its own microphone and transcribes locally, then
// sends finished sentences up the websocket tagged with that person's name.
// Attribution is therefore exact: it came from Sam's laptop, so it was Sam.
//
// This is a separate mic handle from the one the video call uses. Chrome is
// fine with both at once.

export function startListening(ws, name, { onHeard, onStatus } = {}) {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;

  if (!Recognition) {
    onStatus?.("unsupported");
    return { stop() {}, supported: false };
  }

  const rec = new Recognition();
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = "en-US";
  rec.maxAlternatives = 1;

  let running = false;
  let stopped = false;

  rec.onstart = () => { running = true; onStatus?.("listening"); };

  rec.onresult = (event) => {
    let interim = "";

    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      const text = result[0].transcript.trim();

      if (result.isFinal) {
        // Ignore stray single words; they are usually noise or throat-clearing.
        if (text.length > 3) {
          ws.send(JSON.stringify({ type: "say", text, speaker: name }));
          onHeard?.(text, true);
        }
      } else {
        interim = text;
      }
    }

    if (interim) onHeard?.(interim, false);
  };

  rec.onerror = (e) => {
    // "no-speech" and "aborted" are routine in a quiet room. Keep going.
    if (e.error === "not-allowed" || e.error === "service-not-allowed") {
      stopped = true;
      onStatus?.("denied");
    }
  };

  rec.onend = () => {
    running = false;
    // Chrome ends the session periodically on its own. Restart unless we
    // deliberately stopped, otherwise listening quietly dies mid demo.
    if (!stopped) {
      setTimeout(() => {
        try { rec.start(); } catch { /* already starting */ }
      }, 250);
    } else {
      onStatus?.("off");
    }
  };

  try {
    rec.start();
  } catch {
    onStatus?.("error");
  }

  return {
    supported: true,
    stop() {
      stopped = true;
      try { rec.stop(); } catch { /* nothing to stop */ }
    },
    resume() {
      stopped = false;
      try { rec.start(); } catch { /* already running */ }
    },
    get running() { return running; },
  };
}
