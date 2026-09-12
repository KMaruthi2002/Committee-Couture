"""
The two places that touch Gemini. Both are isolated here so that when an SDK
signature surprises you, exactly one file needs editing.

Do not trust the exact call shapes below from memory. Open the docs, confirm,
then fill them in. Everything around these functions is already correct.
"""

import asyncio
import base64
import os
from pathlib import Path
from typing import Callable, Awaitable, Optional

IMAGE_MODEL = os.getenv("IMAGE_MODEL", "gemini-3.1-flash-lite-image")
LIVE_MODEL = os.getenv("LIVE_MODEL", "gemini-3.1-flash-live-preview")
TEMPERATURE = 0.4   # proven in testing. Higher and the coat changes between runs.


# ---------------------------------------------------------------------
# SEAM 2: image render
# docs: ai.google.dev/gemini-api/docs/image-generation
# ---------------------------------------------------------------------

async def render(prompt: str, base_photo: Path, mock: bool = True) -> str:
    """
    Send the ORIGINAL photo plus the composed prompt. Return a base64 data URL.

    Never send a previously generated image back in. That is the whole point of
    the architecture and it is easy to break by accident when adding features.
    """
    if mock:
        await asyncio.sleep(1.2)          # stand in for real latency
        return _data_url(base_photo)

    from google import genai
    from google.genai import types

    client = genai.Client(api_key=os.environ["GOOGLE_API_KEY"])

    image_bytes = base_photo.read_bytes()

    response = await asyncio.to_thread(
        client.models.generate_content,
        model=IMAGE_MODEL,
        contents=[
            types.Part.from_bytes(data=image_bytes, mime_type="image/jpeg"),
            prompt,
        ],
        config=types.GenerateContentConfig(temperature=TEMPERATURE),
    )

    for part in response.candidates[0].content.parts:
        if getattr(part, "inline_data", None):
            b64 = base64.b64encode(part.inline_data.data).decode()
            return f"data:{part.inline_data.mime_type};base64,{b64}"

    raise RuntimeError("no image in response")


def _data_url(path: Path) -> str:
    return "data:image/jpeg;base64," + base64.b64encode(path.read_bytes()).decode()


# ---------------------------------------------------------------------
# SEAM 1: live session
# docs: ai.google.dev/gemini-api/docs/live
# ---------------------------------------------------------------------

class LiveSession:
    """
    Thin wrapper. main.py only needs send_audio() and close(); everything else
    is internal, so you can restructure this freely to match the real SDK.
    """

    def __init__(self, session, on_tool_call, on_speech):
        self._session = session
        self._on_tool_call = on_tool_call
        self._on_speech = on_speech
        self._pump: Optional[asyncio.Task] = None

    async def send_audio(self, pcm: bytes) -> None:
        await self._session.send_realtime_input(
            audio={"data": pcm, "mime_type": "audio/pcm;rate=16000"}
        )

    async def _read_loop(self) -> None:
        async for message in self._session.receive():
            tool_call = getattr(message, "tool_call", None)
            if tool_call:
                for fc in tool_call.function_calls:
                    await self._on_tool_call(fc.name, dict(fc.args or {}))

            text = getattr(message, "text", None)
            if text:
                self._on_speech(text)

    def start(self) -> None:
        self._pump = asyncio.create_task(self._read_loop())

    async def close(self) -> None:
        if self._pump:
            self._pump.cancel()


async def start_live_session(
    on_tool_call: Callable[[str, dict], Awaitable[None]],
    on_speech: Callable[[str], None],
) -> LiveSession:
    from google import genai
    from google.genai import types
    from look_state import TOOLS

    system_prompt = Path("system_prompt.md").read_text()

    client = genai.Client(api_key=os.environ["GOOGLE_API_KEY"])

    session = await client.aio.live.connect(
        model=LIVE_MODEL,
        config=types.LiveConnectConfig(
            response_modalities=["AUDIO"],
            system_instruction=system_prompt,
            tools=[{"function_declarations": TOOLS}],
        ),
    ).__aenter__()

    live = LiveSession(session, on_tool_call, on_speech)
    live.start()
    return live
