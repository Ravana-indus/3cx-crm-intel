from __future__ import annotations

import os
import tempfile

from .. import media
from .base import Engine, Transcription


class AutoEngine(Engine):
    """
    Detect the language on the first 30 seconds, then route Tamil to Parakeet
    and everything else to Whisper. This is the Phase 0 decision implemented as
    a config choice, not a rewrite.
    """

    name = "auto"

    def __init__(self, whisper, parakeet=None, ffmpeg: str = "ffmpeg"):
        self.whisper = whisper
        self.parakeet = parakeet
        self.ffmpeg = ffmpeg
        self.model = (
            f"auto({whisper.model}"
            f"{'+parakeet' if parakeet is not None else ''})"
        )

    def transcribe(
        self,
        audio_path: str,
        hints: str | None = None,
        speaker: str | None = None,
    ) -> Transcription:
        with tempfile.TemporaryDirectory(prefix="3cx-langid-") as workdir:
            clip = media.clip(
                audio_path,
                os.path.join(workdir, "langid.wav"),
                seconds=30,
                ffmpeg=self.ffmpeg,
            )
            language = self.whisper.detect_language(clip)

        if language == "ta" and self.parakeet is not None:
            result = self.parakeet.transcribe(audio_path, hints=hints, speaker=speaker)
            result.language = language
            return result

        return self.whisper.transcribe(audio_path, hints=hints, speaker=speaker)
