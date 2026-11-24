from __future__ import annotations

import json
import subprocess
from pathlib import Path


class MediaError(RuntimeError):
    pass


def _run(command: list[str]) -> subprocess.CompletedProcess:
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode != 0:
        raise MediaError(
            f"command failed: {' '.join(command)}: {result.stderr.strip()[:300]}"
        )
    return result


def probe(path: str | Path, ffprobe: str = "ffprobe") -> dict:
    result = _run(
        [
            ffprobe,
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
            str(path),
        ]
    )
    data = json.loads(result.stdout or "{}")
    audio = next(
        (
            stream
            for stream in data.get("streams", [])
            if stream.get("codec_type") == "audio"
        ),
        {},
    )
    try:
        duration = float(data.get("format", {}).get("duration"))
    except (TypeError, ValueError):
        duration = None

    return {
        "channels": int(audio.get("channels") or 1),
        "sample_rate": int(audio.get("sample_rate") or 0),
        "duration": duration,
    }


def to_mono_16k(src: str | Path, dst: str | Path, ffmpeg: str = "ffmpeg") -> str:
    _run(
        [
            ffmpeg,
            "-y",
            "-loglevel",
            "error",
            "-i",
            str(src),
            "-ac",
            "1",
            "-ar",
            "16000",
            str(dst),
        ]
    )
    return str(dst)


def split_channels(
    src: str | Path, out_dir: str | Path, ffmpeg: str = "ffmpeg"
) -> tuple[str, str]:
    """
    3CX writes caller and agent on separate channels for recorded calls.
    Channel 0 is treated as the caller and channel 1 as the agent.
    """
    left = str(Path(out_dir) / "caller.wav")
    right = str(Path(out_dir) / "agent.wav")

    _run(
        [
            ffmpeg,
            "-y",
            "-loglevel",
            "error",
            "-i",
            str(src),
            "-af",
            "pan=mono|c0=c0",
            "-ar",
            "16000",
            left,
        ]
    )
    _run(
        [
            ffmpeg,
            "-y",
            "-loglevel",
            "error",
            "-i",
            str(src),
            "-af",
            "pan=mono|c0=c1",
            "-ar",
            "16000",
            right,
        ]
    )

    return left, right


def clip(
    src: str | Path, dst: str | Path, seconds: int = 30, ffmpeg: str = "ffmpeg"
) -> str:
    _run(
        [
            ffmpeg,
            "-y",
            "-loglevel",
            "error",
            "-i",
            str(src),
            "-t",
            str(seconds),
            "-ac",
            "1",
            "-ar",
            "16000",
            str(dst),
        ]
    )
    return str(dst)
