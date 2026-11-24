from __future__ import annotations

from ..config import Config
from .auto import AutoEngine
from .base import Engine, EngineUnavailable, Transcription
from .fluidvoice import FluidVoiceEngine
from .mock import MockEngine
from .nemo import NemoEngine
from .whisper import WhisperEngine

__all__ = [
    "Engine",
    "EngineUnavailable",
    "Transcription",
    "MockEngine",
    "WhisperEngine",
    "NemoEngine",
    "AutoEngine",
    "FluidVoiceEngine",
    "build_engine",
]


def build_engine(config: Config) -> Engine:
    name = config.engine

    if name == "mock":
        return MockEngine(
            language=config.mock_language, ffprobe=config.ffprobe
        )

    if name == "whisper":
        return WhisperEngine(
            model_name=config.whisper_model,
            device=config.whisper_device,
            compute_type=config.whisper_compute_type,
            language=config.language,
        )

    if name == "nemo":
        return NemoEngine(model_path=config.parakeet_model)

    if name == "fluidvoice":
        return FluidVoiceEngine(
            base_url=config.fluidvoice_url,
            timeout=config.fluidvoice_timeout,
            language=config.fluidvoice_language,
            allowed_languages=config.fluidvoice_allowed_languages,
            diarize=config.diarise and config.fluidvoice_diarize,
            diarizer_cli=config.fluidvoice_diarizer_cli,
            diarizer=config.fluidvoice_diarizer,
            diarizer_timeout=config.fluidvoice_diarizer_timeout,
            max_speakers=config.fluidvoice_speaker_count,
            ffmpeg=config.ffmpeg,
        )

    if name == "auto":
        whisper = WhisperEngine(
            model_name=config.whisper_model,
            device=config.whisper_device,
            compute_type=config.whisper_compute_type,
            language=config.language,
        )
        parakeet = None
        try:
            parakeet = NemoEngine(model_path=config.parakeet_model)
        except EngineUnavailable:
            parakeet = None
        return AutoEngine(whisper, parakeet, ffmpeg=config.ffmpeg)

    raise ValueError(
        f"unknown TRANSCRIBER_ENGINE={name!r} (mock|whisper|nemo|auto)"
    )
