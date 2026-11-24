from __future__ import annotations

from .base import Engine, EngineUnavailable, Transcription


class WhisperEngine(Engine):
    """faster-whisper: CPU-friendly and easy to install on macOS."""

    name = "whisper"

    def __init__(
        self,
        model_name: str = "large-v3",
        device: str = "auto",
        compute_type: str = "int8",
        language: str | None = None,
    ):
        try:
            from faster_whisper import WhisperModel
        except ImportError as exc:  # pragma: no cover - optional dependency
            raise EngineUnavailable(
                "faster-whisper is not installed. Run "
                "pip install faster-whisper (and brew install ffmpeg)."
            ) from exc

        self.model_name = model_name
        self.language = language

        try:
            self._model = WhisperModel(
                model_name, device=device, compute_type=compute_type
            )
        except Exception as exc:  # pragma: no cover - model download/runtime
            raise EngineUnavailable(
                f"could not load whisper model {model_name}: {exc}"
            ) from exc

    @property
    def model(self) -> str:
        return self.model_name

    def transcribe(
        self,
        audio_path: str,
        hints: str | None = None,
        speaker: str | None = None,
    ) -> Transcription:
        segments_iter, info = self._model.transcribe(
            audio_path,
            language=self.language,
            initial_prompt=hints or None,
            vad_filter=True,
            beam_size=5,
        )

        segments: list[dict] = []
        texts: list[str] = []
        language = (
            getattr(info, "language", None) or self.language or "unknown"
        )
        for segment in segments_iter:
            text = segment.text.strip()
            if not text:
                continue
            segments.append(
                {
                    "start": round(segment.start, 2),
                    "end": round(segment.end, 2),
                    "text": text,
                    "speaker": speaker,
                    "language": language,
                    "confidence": (
                        float(segment.probability)
                        if getattr(segment, "probability", None) is not None
                        else None
                    ),
                }
            )
            texts.append(text)

        return Transcription(
            language=language,
            text=" ".join(texts).strip(),
            segments=segments,
            model=self.model_name,
            engine=self.name,
        )

    def detect_language(self, audio_path: str) -> str:
        _, info = self._model.transcribe(
            audio_path, beam_size=1, vad_filter=True
        )
        return getattr(info, "language", None) or self.language or "unknown"
