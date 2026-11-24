from __future__ import annotations

import os
from dataclasses import dataclass


def _flag(name: str, default: bool) -> bool:
    value = os.environ.get(name)
    if value is None:
        return default
    return value.strip().lower() not in ("0", "false", "no", "off", "")


@dataclass(frozen=True)
class Config:
    bridge_url: str
    worker_token: str
    engine: str
    whisper_model: str
    whisper_device: str
    whisper_compute_type: str
    language: str | None
    poll_seconds: float
    diarise: bool
    ffmpeg: str
    ffprobe: str
    mock_language: str
    parakeet_model: str | None
    fluidvoice_url: str
    fluidvoice_timeout: float
    fluidvoice_language: str | None
    fluidvoice_allowed_languages: list[str]
    fluidvoice_diarize: bool
    fluidvoice_diarizer_cli: str
    fluidvoice_diarizer: str
    fluidvoice_diarizer_timeout: float
    fluidvoice_speaker_count: int
    max_jobs: int

    @classmethod
    def from_env(cls) -> "Config":
        return cls(
            bridge_url=os.environ.get("BRIDGE_URL", "http://127.0.0.1:8080").rstrip("/"),
            worker_token=os.environ.get("WORKER_TOKEN", "dev-worker-token"),
            engine=os.environ.get("TRANSCRIBER_ENGINE", "fluidvoice").strip().lower(),
            whisper_model=os.environ.get("WHISPER_MODEL", "large-v3"),
            whisper_device=os.environ.get("WHISPER_DEVICE", "auto"),
            whisper_compute_type=os.environ.get("WHISPER_COMPUTE_TYPE", "int8"),
            language=os.environ.get("TRANSCRIBER_LANGUAGE") or None,
            poll_seconds=float(os.environ.get("TRANSCRIBER_POLL_SECONDS", "5")),
            diarise=_flag("TRANSCRIBER_DIARISE", True),
            ffmpeg=os.environ.get("FFMPEG", "ffmpeg"),
            ffprobe=os.environ.get("FFPROBE", "ffprobe"),
            mock_language=os.environ.get("MOCK_LANGUAGE", "ta"),
            parakeet_model=os.environ.get("PARAKEET_MODEL") or None,
            fluidvoice_url=os.environ.get(
                "FLUIDVOICE_URL", "http://127.0.0.1:8765"
            ),
            fluidvoice_timeout=float(
                os.environ.get("FLUIDVOICE_TIMEOUT", "180")
            ),
            fluidvoice_language=os.environ.get("FLUIDVOICE_LANGUAGE") or None,
            fluidvoice_allowed_languages=[
                code.strip().lower()
                for code in os.environ.get(
                    "FLUIDVOICE_ALLOWED_LANGUAGES", "ta,en,si"
                ).split(",")
                if code.strip()
            ],
            fluidvoice_diarize=_flag("FLUIDVOICE_DIARIZE", True),
            fluidvoice_diarizer_cli=os.environ.get(
                "FLUIDVOICE_DIARIZER_CLI",
                "~/Developer/FluidAudio/.build/release/fluidaudiocli",
            ),
            fluidvoice_diarizer=os.environ.get(
                "FLUIDVOICE_DIARIZER", "sortformer"
            ).strip().lower(),
            fluidvoice_diarizer_timeout=float(
                os.environ.get("FLUIDVOICE_DIARIZER_TIMEOUT", "900")
            ),
            fluidvoice_speaker_count=int(
                os.environ.get("FLUIDVOICE_SPEAKER_COUNT", "2")
            ),
            max_jobs=int(os.environ.get("TRANSCRIBER_MAX_JOBS", "0")),
        )
