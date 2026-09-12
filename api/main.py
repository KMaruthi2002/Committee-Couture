"""
Backend for the group styling call.

One room, one look, held in memory. Restart the server and you lose the look,
which is correct for a ninety second demo.

Everything downstream of dispatch_tool_call is shared between mock mode and
real mode, so work done while blocked on credentials is not thrown away.
"""

import asyncio
import base64
import json
import os
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from look_state import LookState
import gemini_client

load_dotenv()

MOCK = os.getenv("MOCK", "1") == "1"
BASE_PHOTO = Path(os.getenv("BASE_PHOTO", "base.jpg"))

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

state = LookState(base_photo=str(BASE_PHOTO))
clients: set[WebSocket] = set()
render_lock = asyncio.Lock()
last_images: list[str] = []


# ---------------------------------------------------------------------
# Broadcast
# ---------------------------------------------------------------------

async def broadcast(message: dict) -> None:
    dead = []
    for ws in clients:
        try:
            await ws.send_text(json.dumps(message))
        except Exception:
            dead.append(ws)
    for ws in dead:
        clients.discard(ws)


async def push_state(pending: str = "") -> None:
    await broadcast(state.payload(images=last_images, pending=pending))


# ---------------------------------------------------------------------
# Tool dispatch. The single point both modes flow through.
# ---------------------------------------------------------------------

async def dispatch_tool_call(name: str, args: dict) -> None:
    if name == "update_look":
        action = args.get("action", "add")
        item = args.get("item", "")
        attributes = args.get("attributes", "")
        who = args.get("proposed_by", "someone")

        if action == "remove":
            state.remove(item)
        elif action == "modify":
            state.modify(item, attributes, who)
        else:
            state.add(item, attributes, who)

        await push_state(pending=f"{who}: {item} {attributes}".strip())

    elif name == "flag_disagreement":
        state.set_contested(
            args.get("option_a", ""),
            args.get("option_b", ""),
            args.get("wants_a", ""),
            args.get("wants_b", ""),
        )
        await push_state()

    elif name == "commit":
        await do_render()


# ---------------------------------------------------------------------
# Render
# ---------------------------------------------------------------------

async def do_render() -> None:
    global last_images

    if render_lock.locked():
        return

    async with render_lock:
        state.clear_dirty()
        state.bump()
        await broadcast({"type": "rendering"})

        prompts = state.contested_prompts()
        if prompts:
            images = await asyncio.gather(
                gemini_client.render(prompts[0], BASE_PHOTO, mock=MOCK),
                gemini_client.render(prompts[1], BASE_PHOTO, mock=MOCK),
            )
        else:
            images = [await gemini_client.render(state.compose(), BASE_PHOTO, mock=MOCK)]

        last_images = list(images)
        await push_state()


async def settle_watcher() -> None:
    """Render when the room stops adding for a moment."""
    while True:
        await asyncio.sleep(0.3)
        if state.settled():
            await do_render()


@app.on_event("startup")
async def startup() -> None:
    asyncio.create_task(settle_watcher())


# ---------------------------------------------------------------------
# Mock understanding. Stands in for Gemini while you are blocked.
# ---------------------------------------------------------------------

GARMENTS = [
    "coat", "french coat", "jacket", "blazer", "shirt", "trousers", "shoes",
    "beret", "hat", "scarf", "tie", "dress", "suit", "boots", "sweater",
]


def mock_understand(text: str, speaker: str) -> list[tuple[str, dict]]:
    """
    Crude keyword parser. Not trying to be clever. It exists so the UI and the
    render loop can be exercised without a model attached.
    """
    lower = text.lower().strip()

    if lower in ("show me", "show it", "let's see it", "commit"):
        return [("commit", {})]

    if lower.startswith("remove ") or lower.startswith("lose the "):
        item = lower.replace("remove ", "").replace("lose the ", "").strip()
        return [("update_look", {"action": "remove", "item": item, "proposed_by": speaker})]

    item = next((g for g in sorted(GARMENTS, key=len, reverse=True) if g in lower), None)
    if not item:
        return []

    attributes = lower.replace(item, "").strip(" ,.")
    for filler in ("put him in a", "put her in a", "put them in a", "give him a",
                   "give her a", "add a", "add an", "with a", "wearing a", "a "):
        if attributes.startswith(filler):
            attributes = attributes[len(filler):].strip()

    return [("update_look", {
        "action": "add",
        "item": item,
        "attributes": attributes,
        "proposed_by": speaker,
    })]


# ---------------------------------------------------------------------
# Websocket
# ---------------------------------------------------------------------

@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket) -> None:
    await ws.accept()
    clients.add(ws)
    await ws.send_text(json.dumps(state.payload(images=last_images)))

    live = None
    if not MOCK and os.getenv("LIVE", "0") == "1":
        # SEAM 1. Opens the Gemini Live session and pumps tool calls back.
        live = await gemini_client.start_live_session(
            on_tool_call=dispatch_tool_call,
            on_speech=lambda text: asyncio.create_task(
                broadcast({"type": "ack", "text": text})
            ),
        )

    try:
        while True:
            raw = await ws.receive_text()
            msg = json.loads(raw)

            if msg.get("type") == "audio" and live:
                await live.send_audio(base64.b64decode(msg["pcm"]))

            elif msg.get("type") == "say":
                # Mock path: typed text stands in for speech.
                text = msg.get("text", "")
                speaker = msg.get("speaker", "someone")
                await broadcast({"type": "ack", "text": f"{speaker}: {text}"})
                for name, args in mock_understand(text, speaker):
                    await dispatch_tool_call(name, args)

            elif msg.get("type") == "resolve":
                state.resolve(
                    msg.get("item", "hat"),
                    msg.get("chosen", ""),
                    msg.get("by", "the group"),
                )
                await do_render()

    except WebSocketDisconnect:
        pass
    finally:
        clients.discard(ws)
        if live:
            await live.close()


@app.get("/health")
async def health() -> dict:
    return {"ok": True, "mock": MOCK, "layers": len(state.layers)}
