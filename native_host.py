#!/Users/cosmos/miniconda3/bin/python3
"""
ReadAloud - Native Messaging Host
Uses edge-tts to synthesize speech with Edge Neural voices.
Chrome launches this automatically on demand via Native Messaging.
"""

import sys
import os
import struct
import json
import asyncio
import base64

try:
    import edge_tts
except ImportError:
    def _missing():
        msg = json.dumps({"error": "edge-tts not installed. Run: pip install edge-tts"}).encode()
        sys.stdout.buffer.write(struct.pack("=I", len(msg)))
        sys.stdout.buffer.write(msg)
        sys.stdout.buffer.flush()
    _missing()
    sys.exit(1)

# ---- Native Messaging Protocol ----

def read_message():
    """Read a message from Chrome (4-byte length prefix + JSON)."""
    raw = _read_exact(4)
    if not raw:
        return None
    length = struct.unpack("=I", raw)[0]
    # Guard against a corrupted/garbage length that would request a multi-GB
    # read (OOM). Chrome's own messages are well under 64 MB.
    if length == 0 or length > 64 * 1024 * 1024:
        return None
    data = _read_exact(length)
    if not data:
        return None
    return json.loads(data.decode("utf-8"))

def _read_exact(n):
    """Read exactly n bytes from stdin, looping on short reads.

    sys.stdin.buffer.read(n) may return fewer than n bytes if the pipe is
    closed/interrupted mid-message; without looping, a truncated buffer
    reaches json.loads and throws. Returns None on EOF.
    """
    buf = bytearray()
    while len(buf) < n:
        chunk = sys.stdin.buffer.read(n - len(buf))
        if not chunk:
            return None
        buf.extend(chunk)
    return bytes(buf)

def send_message(obj):
    """Send a message to Chrome (4-byte length prefix + JSON)."""
    data = json.dumps(obj, separators=(",", ":")).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("=I", len(data)))
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()

# ---- Edge TTS ----

async def synthesize(text, voice, rate_str):
    """Synthesize text and return audio + word boundaries."""
    comm = edge_tts.Communicate(text, voice=voice, rate=rate_str, boundary="WordBoundary")
    audio = bytearray()
    boundaries = []
    word_idx = 0

    async for chunk in comm.stream():
        if chunk["type"] == "audio":
            audio.extend(chunk["data"])
        elif chunk["type"] == "WordBoundary":
            boundaries.append({
                "offset": chunk["offset"],        # 100ns ticks
                "duration": chunk["duration"],     # 100ns ticks
                "text": chunk["text"],
                "index": word_idx,
            })
            word_idx += 1

    return {
        "audio": base64.b64encode(bytes(audio)).decode("ascii"),
        "boundaries": boundaries,
    }

async def get_voices():
    """Return available Edge TTS voices."""
    voices = await edge_tts.list_voices()
    return [
        {
            "name": v["ShortName"],
            "gender": v["Gender"],
            "locale": v["Locale"],
            "friendly": v.get("FriendlyName", v["ShortName"]),
        }
        for v in voices
    ]

# ---- Main Loop ----

async def handle(msg):
    action = msg.get("action", "")

    if action == "synthesize":
        return await synthesize(
            msg["text"],
            msg.get("voice", "en-US-JennyNeural"),
            msg.get("rate", "+0%"),
        )

    if action == "getVoices":
        return {"voices": await get_voices()}

    if action == "ping":
        return {"pong": True}

    return {"error": f"Unknown action: {action}"}


async def _handle_and_respond(msg):
    """Process one message and send the response back to Chrome."""
    try:
        result = await handle(msg)
    except asyncio.CancelledError:
        # Synthesis was cancelled by a newer message — respond so
        # Chrome's sendNativeMessage callback doesn't hang forever.
        send_message({"error": "cancelled"})
        return
    except Exception as e:
        result = {"error": str(e)}
    try:
        send_message(result)
    except Exception:
        pass


async def main_loop():
    """
    Concurrent main loop: reads stdin in a background thread so that
    a new message can cancel an in-flight synthesis immediately,
    instead of queuing behind it.
    """
    loop = asyncio.get_event_loop()
    current_task = None

    while True:
        # Read stdin in a thread pool so the event loop stays responsive.
        # Timeout is a safety net only: the background service worker sends a
        # ping every ~2 minutes while a reading session is active (see the
        # "native-keepalive" alarm in background.js), which keeps stdin fed.
        try:
            msg = await asyncio.wait_for(
                loop.run_in_executor(None, read_message),
                timeout=3600,
            )
        except asyncio.TimeoutError:
            # Must force-exit: the stdin-reading thread is still blocking
            # in the thread pool and cannot be interrupted. Normal return
            # would hang on executor.shutdown(wait=True).
            os._exit(0)

        if msg is None:
            # stdin closed (Chrome recycled the host). If a synthesis is still
            # in flight, let it finish and send the real result rather than
            # cancelling — a cancel surfaces as {"error":"cancelled"} which the
            # extension treats as a playback failure. Bounded wait so a hung
            # task can't keep the host alive indefinitely.
            if current_task is not None and not current_task.done():
                try:
                    await asyncio.wait_for(current_task, timeout=30)
                except (asyncio.TimeoutError, asyncio.CancelledError, Exception):
                    current_task.cancel()
            break

        # Only a new synthesis request is allowed to preempt an in-flight one.
        # Lightweight messages (ping/getVoices) must NOT cancel synthesis:
        # background.js uses one-shot sendNativeMessage, and a cancelled
        # synthesis emits {"error":"cancelled"} which Chrome routes (FIFO) to
        # the earliest pending callback — often the main playback request,
        # making it appear to fail and aborting playback. ping/getVoices are
        # cheap and run alongside the synthesis task.
        action = msg.get("action", "")
        if action == "synthesize" and current_task is not None and not current_task.done():
            current_task.cancel()

        current_task = asyncio.create_task(_handle_and_respond(msg))


def main():
    try:
        asyncio.run(main_loop())
    except Exception:
        pass

if __name__ == "__main__":
    main()
