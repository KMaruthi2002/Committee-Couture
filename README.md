# Second opinion

A group video call where friends style one person, and the picture changes as
they talk. The AI is not the stylist. They are.

## The one architectural rule

The base photo is never replaced by a generated image. Suggestions accumulate
as *text layers*, and every render goes from the original plus the full layer
list. Generation depth is always 1, so the subject's face cannot drift over a
long call no matter how many changes the group makes.

If you change one thing in this codebase, do not change that.

## Running it

Backend:

```
cd api
python -m venv .venv && source .venv/bin/activate
pip install fastapi uvicorn websockets python-dotenv google-genai
cp ../.env.example .env        # fill in what you have
uvicorn main:app --reload --port 8000
```

Frontend:

```
cd web
npm install
npm run dev
```

Open `http://localhost:5173/?role=host` in one tab and
`http://localhost:5173/?role=guest` in another.

## Mock mode

Set `MOCK=1` in `api/.env` and the whole app runs with no Vonage and no Gemini.
Instead of speaking, you type suggestions into a box and they flow through the
exact same tool dispatch path the real model uses. The render returns the base
photo with a caption of the current layers.

This exists so you can build and rehearse the UI while blocked on credentials.
Everything downstream of `dispatch_tool_call` is identical in both modes, so
work you do in mock mode is not throwaway.

## The seams

Three places need real SDK calls. They are all isolated and marked `SEAM` in
the code. Check current signatures against the docs rather than trusting any
code written from memory.

1. `api/gemini_client.py` → `start_live_session()`
   Opens the Gemini Live session, registers `TOOLS`, streams audio in, yields
   tool calls and spoken text out. Docs: ai.google.dev/gemini-api/docs/live

2. `api/gemini_client.py` → `render()`
   Calls `gemini-3.1-flash-lite-image` with the base photo plus the composed
   prompt. Temperature 0.4. Returns a base64 data URL.
   Docs: ai.google.dev/gemini-api/docs/image-generation

3. `web/src/call.js` → `joinRoom()`
   Vonage session init, publish, subscribe. The audio mixing below it is
   already written and does not depend on Vonage specifics beyond getting a
   `MediaStream` per subscriber.

## Build order tomorrow

Get the Vonage room connecting first. Then `joinRoom`. Then swap `MOCK=0` and
fill the two Gemini seams. The UI and the state logic are already done and do
not need touching.

Freeze at 1:40pm and rehearse twice, out loud, all the way through.

## Demo script

Four beats, about ninety seconds.

1. "Put him in a green French coat with black buttons."
2. "Grey piping on the collar."
3. "A beige beret, tilted left."
4. One friend objects to the beret, the other defends it. Side by side appears.
   They settle. Final look.

End on the before and after.
