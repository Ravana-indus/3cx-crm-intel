from __future__ import annotations

import io
import json
import math
import struct
import tempfile
import threading
import unittest
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from transcriber.engines.fluidvoice import (
    FluidVoiceEngine,
    merge_turns,
    parse_process_payload,
    parse_sortformer_payload,
    parse_sortformer_output,
)


def wav_bytes(duration: float = 0.5, rate: int = 16000) -> bytes:
    frames = int(duration * rate)
    data = bytearray()
    for index in range(frames):
        value = int(3000 * math.sin(2 * math.pi * 440 * index / rate))
        data += struct.pack("<h", value)

    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(rate)
        handle.writeframes(bytes(data))
    return buffer.getvalue()


class FluidVoiceHandler(BaseHTTPRequestHandler):
    requests: list[tuple[str, str, bytes]] = []
    reject_raw = False
    transcript = "fluid voice heard this"
    provider = "Whisper Large Turbo"

    def log_message(self, *args) -> None:
        return

    def _json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/v1/health":
            self._json(200, {"status": "ok", "version": "test"})
        else:
            self._json(404, {"error": "Route not found."})

    def do_POST(self) -> None:  # noqa: N802
        length = int(self.headers.get("content-length", "0"))
        body = self.rfile.read(length) if length else b""
        content_type = self.headers.get("content-type", "")
        type(self).requests.append((self.path, content_type, body))

        if self.path != "/v1/transcribe":
            self._json(404, {"error": "Route not found."})
            return

        if type(self).reject_raw and content_type.startswith("audio/"):
            self._json(400, {"error": "Invalid JSON audio payload."})
            return

        self._json(
            200,
            {
                "text": type(self).transcript,
                "provider": type(self).provider,
                "confidence": 0.91,
                "sampleCount": 8000,
            },
        )


class FluidVoiceEngineTests(unittest.TestCase):
    def setUp(self) -> None:
        FluidVoiceHandler.requests = []
        FluidVoiceHandler.reject_raw = False
        FluidVoiceHandler.transcript = "fluid voice heard this"
        FluidVoiceHandler.provider = "Whisper Large Turbo"
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), FluidVoiceHandler)
        self.thread = threading.Thread(
            target=self.server.serve_forever, daemon=True
        )
        self.thread.start()
        self.base_url = f"http://127.0.0.1:{self.server.server_address[1]}"

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()

    def write_wav(self, directory: str) -> Path:
        path = Path(directory) / "speech.wav"
        path.write_bytes(wav_bytes())
        return path

    def test_transcribes_with_raw_wav_body(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = self.write_wav(directory)
            engine = FluidVoiceEngine(self.base_url, timeout=10)
            result = engine.transcribe(str(path))

        self.assertEqual(result.text, "fluid voice heard this")
        self.assertEqual(result.language, "en")
        self.assertIn("Whisper", result.model)
        self.assertEqual(len(result.segments), 1)
        self.assertGreater(result.segments[0]["end"], 0)

        self.assertEqual(FluidVoiceHandler.requests[0][0], "/v1/transcribe")
        self.assertEqual(FluidVoiceHandler.requests[0][1], "audio/wav")

    def test_keeps_tamil_english_sinhala(self) -> None:
        cases = [
            ("Hello, this is a test", "en"),
            ("வணக்கம், இது ஒரு தமிழ் சோதனை", "ta"),
            ("ආයුබෝවන්, මෙය සිංහල පරීක්ෂණයකි", "si"),
        ]
        with tempfile.TemporaryDirectory() as directory:
            path = self.write_wav(directory)
            for text, language in cases:
                FluidVoiceHandler.transcript = text
                engine = FluidVoiceEngine(
                    self.base_url,
                    timeout=10,
                    allowed_languages=["ta", "en", "si"],
                )
                result = engine.transcribe(str(path))
                self.assertFalse(result.skipped, text)
                self.assertEqual(result.language, language)
                self.assertEqual(result.text, text)

    def test_skips_other_languages(self) -> None:
        FluidVoiceHandler.transcript = "नमस्ते, यह एक परीक्षण है"
        with tempfile.TemporaryDirectory() as directory:
            path = self.write_wav(directory)
            engine = FluidVoiceEngine(
                self.base_url,
                timeout=10,
                allowed_languages=["ta", "en", "si"],
            )
            result = engine.transcribe(str(path))

        self.assertTrue(result.skipped)
        self.assertEqual(result.language, "unknown")
        self.assertEqual(result.text, "")
        self.assertEqual(result.segments, [])

    def test_falls_back_to_json_base64(self) -> None:
        FluidVoiceHandler.reject_raw = True
        with tempfile.TemporaryDirectory() as directory:
            path = self.write_wav(directory)
            engine = FluidVoiceEngine(self.base_url, timeout=10)
            result = engine.transcribe(str(path))

        self.assertEqual(result.text, "fluid voice heard this")
        types = [entry[1] for entry in FluidVoiceHandler.requests]
        self.assertIn("audio/wav", types)
        self.assertIn("application/json", types)
        json_request = [
            entry for entry in FluidVoiceHandler.requests
            if entry[1] == "application/json"
        ][0]
        payload = json.loads(json_request[2])
        self.assertIn("audioBase64", payload)
        self.assertEqual(payload["filename"], "speech.wav")

    def test_health(self) -> None:
        engine = FluidVoiceEngine(self.base_url, timeout=10)
        self.assertEqual(engine.health()["status"], "ok")

    def test_merges_turns_and_labels_speakers(self) -> None:
        turns = merge_turns(
            [
                {"speaker": "A", "start": 0.0, "end": 2.0},
                {"speaker": "A", "start": 3.0, "end": 4.0},
                {"speaker": "B", "start": 5.0, "end": 7.0},
                {"speaker": "A", "start": 0.2, "end": 0.5},
            ]
        )

        self.assertEqual(len(turns), 2)
        self.assertEqual([turn["speaker"] for turn in turns], ["Speaker 1", "Speaker 2"])
        self.assertEqual((turns[0]["start"], turns[0]["end"]), (0.0, 4.0))
        self.assertEqual((turns[1]["start"], turns[1]["end"]), (5.0, 7.0))

    def test_parses_process_and_sortformer_output(self) -> None:
        process = parse_process_payload(
            {
                "segments": [
                    {
                        "speakerId": "Speaker 1",
                        "startTimeSeconds": 0.1,
                        "endTimeSeconds": 1.2,
                    }
                ]
            }
        )
        self.assertEqual(process[0]["speaker"], "Speaker 1")
        self.assertEqual((process[0]["start"], process[0]["end"]), (0.1, 1.2))

        sortformer_payload = parse_sortformer_payload(
            {
                "segments": [
                    {
                        "speaker": "Speaker 2",
                        "startTimeSeconds": 2.0,
                        "endTimeSeconds": 3.5,
                    }
                ]
            }
        )
        self.assertEqual(sortformer_payload[0]["speaker"], "Speaker 2")
        self.assertEqual(
            (sortformer_payload[0]["start"], sortformer_payload[0]["end"]),
            (2.0, 3.5),
        )

        sortformer = parse_sortformer_output(
            "Speaker 2: 2.50s - 4.00s\nignored log line\nSpeaker 1: 0.00s - 1.50s"
        )
        self.assertEqual(len(sortformer), 2)
        self.assertEqual(sortformer[0]["speaker"], "Speaker 2")
        self.assertEqual((sortformer[0]["start"], sortformer[0]["end"]), (2.5, 4.0))

    def test_limits_diarization_to_two_speakers(self) -> None:
        turns = merge_turns(
            [
                {"speaker": "A", "start": 0.0, "end": 10.0},
                {"speaker": "B", "start": 10.0, "end": 13.0},
                {"speaker": "C", "start": 13.0, "end": 14.5},
            ],
            max_speakers=2,
        )

        self.assertEqual([turn["speaker"] for turn in turns], ["Speaker 1", "Speaker 2"])
        self.assertEqual((turns[0]["start"], turns[0]["end"]), (0.0, 10.0))
        self.assertEqual((turns[1]["start"], turns[1]["end"]), (10.0, 13.0))

    def test_diarizes_then_transcribes_each_turn(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "speech.wav"
            path.write_bytes(wav_bytes(duration=2.0))

            cli = Path(directory) / "fake-fluidaudiocli"
            cli.write_text(
                """#!/bin/sh
if [ "$1" = "process" ]; then
  out=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --output) out="$2"; shift ;;
    esac
    shift
  done
  printf '%s' '{"segments":[{"speakerId":"Speaker 1","startTimeSeconds":0.0,"endTimeSeconds":0.8},{"speakerId":"Speaker 2","startTimeSeconds":1.0,"endTimeSeconds":1.8}]}' > "$out"
  exit 0
fi
exit 1
"""
            )
            cli.chmod(0o755)

            engine = FluidVoiceEngine(
                self.base_url,
                timeout=10,
                diarize=True,
                diarizer_cli=str(cli),
            )
            result = engine.transcribe(str(path))

        self.assertFalse(result.skipped)
        self.assertEqual(len(result.segments), 2)
        self.assertEqual(
            [segment["speaker"] for segment in result.segments],
            ["Speaker 1", "Speaker 2"],
        )
        self.assertEqual(result.text, "fluid voice heard this fluid voice heard this")
        self.assertEqual(len(FluidVoiceHandler.requests), 3)

    def test_skips_diarization_when_cli_is_missing(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = self.write_wav(directory)
            engine = FluidVoiceEngine(
                self.base_url,
                timeout=10,
                diarize=True,
                diarizer_cli="/does/not/exist",
            )
            result = engine.transcribe(str(path))

        self.assertFalse(result.skipped)
        self.assertEqual(len(result.segments), 1)
        self.assertIsNone(result.segments[0]["speaker"])


if __name__ == "__main__":
    unittest.main()
