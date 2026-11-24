from __future__ import annotations

from dataclasses import dataclass


class EngineUnavailable(RuntimeError):
    """Raised when an optional speech engine's dependencies are missing."""


@dataclass
class Transcription:
    language: str
    text: str
    segments: list[dict]
    model: str
    engine: str
    skipped: bool = False


class Engine:
    name = "base"
    model = "unknown"

    def transcribe(
        self,
        audio_path: str,
        hints: str | None = None,
        speaker: str | None = None,
    ) -> Transcription:
        raise NotImplementedError
