from __future__ import annotations

from .. import media
from .base import Engine, Transcription


class MockEngine(Engine):
    """
    Deterministic engine for development and tests. It reads the real audio
    duration with ffprobe, then emits placeholder segments, so the whole
    transcript -> summary -> webhook path runs without a model.
    """

    name = "mock"

    def __init__(self, language: str = "ta", ffprobe: str = "ffprobe"):
        self.language = language
        self.model = "mock-v1"
        self.ffprobe = ffprobe

    def transcribe(
        self,
        audio_path: str,
        hints: str | None = None,
        speaker: str | None = None,
    ) -> Transcription:
        info = media.probe(audio_path, ffprobe=self.ffprobe)
        duration = info.get("duration") or 1.0
        segments: list[dict] = []

        start = 0.0
        index = 0
        while start < duration:
            end = min(duration, start + 5.0)
            prefix = f"{speaker}: " if speaker else ""
            segments.append(
                {
                    "start": round(start, 2),
                    "end": round(end, 2),
                    "text": f"{prefix}mock segment {index + 1}",
                    "speaker": speaker,
                    "language": self.language,
                    "confidence": 0.99,
                }
            )
            start = end
            index += 1

        text = " ".join(segment["text"] for segment in segments)
        return Transcription(
            language=self.language,
            text=text,
            segments=segments,
            model=self.model,
            engine=self.name,
        )
