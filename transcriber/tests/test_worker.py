from __future__ import annotations

import io
import json
import math
import os
import struct
import threading
import unittest
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

from transcriber import worker
from transcriber.config import Config
from transcriber.engines import MockEngine, build_engine
from transcriber.engines.base import EngineUnavailable


def wav_bytes(duration: float = 1.0, rate: int = 8000, channels: int = 2) -> bytes:
    frames = int(duration * rate)
    data = bytearray()
    for index in range(frames):
        value = int(3000 * math.sin(2 * math.pi * 440 * index / rate))
        for _ in range(channels):
            data += struct.pack("<h", value)

    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as handle:
        handle.setnchannels(channels)
        handle.setsampwidth(2)
        handle.setframerate(rate)
        handle.writeframes(bytes(data))
    return buffer.getvalue()


class StubBridgeHandler(BaseHTTPRequestHandler):
    jobs: list[dict] = []
    results: list[dict] = []
    audio: bytes = b""

    def log_message(self, *args) -> None:  # silence test output
        return

    def _json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self) -> None:  # noqa: N802 - stdlib handler naming
        length = int(self.headers.get("content-length", "0"))
        raw = self.rfile.read(length) if length else b""

        if self.path == "/internal/jobs/claim":
            job = type(self).jobs.pop(0) if type(self).jobs else None
            self._json(200, {"job": job})
            return

        if self.path.startswith("/internal/jobs/") and self.path.endswith(
            "/result"
        ):
            type(self).results.append(json.loads(raw or b"{}"))
            self._json(200, {"ok": True})
            return

        self._json(404, {"error": "not_found"})

    def do_GET(self) -> None:  # noqa: N802 - stdlib handler naming
        if self.path.startswith("/internal/audio/"):
            body = type(self).audio
            self.send_response(200)
            self.send_header("content-type", "audio/wav")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        self._json(404, {"error": "not_found"})


class RaisingEngine:
    name = "raising"
    model = "raising-v1"

    def transcribe(self, audio_path, hints=None, speaker=None):
        raise RuntimeError("engine exploded")


class WorkerTests(unittest.TestCase):
    def setUp(self) -> None:
        StubBridgeHandler.audio = wav_bytes()
        StubBridgeHandler.jobs = [
            {
                "id": "job-1",
                "type": "transcribe",
                "ref_id": "rec-1",
                "attempts": 1,
                "audio_url": "/internal/audio/job-1",
                "hints": "Germany, work visa",
            }
        ]
        StubBridgeHandler.results = []

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), StubBridgeHandler)
        self.thread = threading.Thread(
            target=self.server.serve_forever, daemon=True
        )
        self.thread.start()
        self.base_url = f"http://127.0.0.1:{self.server.server_address[1]}"

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()

    def config(self, **overrides) -> Config:
        env = {
            "BRIDGE_URL": self.base_url,
            "WORKER_TOKEN": "test-worker",
            "TRANSCRIBER_ENGINE": "mock",
            "MOCK_LANGUAGE": "ta",
            "TRANSCRIBER_DIARISE": "1",
        }
        env.update(overrides)
        with patch.dict(os.environ, env, clear=False):
            return Config.from_env()

    def test_build_mock_engine(self) -> None:
        engine = build_engine(self.config())
        self.assertIsInstance(engine, MockEngine)
        self.assertEqual(engine.name, "mock")
        self.assertEqual(engine.model, "mock-v1")

    def test_unknown_engine_is_rejected(self) -> None:
        with self.assertRaises(ValueError):
            build_engine(self.config(TRANSCRIBER_ENGINE="nope"))

    def test_processes_a_stereo_job_end_to_end(self) -> None:
        processed = worker.run(self.config(), max_jobs=1)

        self.assertEqual(processed, 1)
        self.assertEqual(len(StubBridgeHandler.results), 1)

        result = StubBridgeHandler.results[0]
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["engine"], "mock")
        self.assertEqual(result["model"], "mock-v1")
        self.assertEqual(result["language"], "ta")
        self.assertIn("mock segment", result["text"])

        speakers = {segment.get("speaker") for segment in result["segments"]}
        self.assertEqual(speakers, {"caller", "agent"})

    def test_reports_engine_failures_back_to_the_bridge(self) -> None:
        with patch.object(worker, "build_engine", return_value=RaisingEngine()):
            processed = worker.run(self.config(), max_jobs=1)

        self.assertEqual(processed, 1)
        self.assertEqual(len(StubBridgeHandler.results), 1)
        result = StubBridgeHandler.results[0]
        self.assertEqual(result["status"], "error")
        self.assertIn("engine exploded", result["error"])

    def test_missing_engine_reports_helpful_error(self) -> None:
        # Building a real engine with missing optional deps should not crash the
        # CLI with a traceback-only failure.
        with patch.dict(os.environ, {"TRANSCRIBER_ENGINE": "nemo"}, clear=False):
            config = Config.from_env()
            try:
                build_engine(config)
            except EngineUnavailable as exc:
                self.assertIn("nemo", str(exc).lower())


if __name__ == "__main__":
    unittest.main()
