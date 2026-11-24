from __future__ import annotations

import base64
import json
import logging
import os
import re
import subprocess
import tempfile
import urllib.error
import urllib.request
from pathlib import Path

from .. import media
from .base import Engine, EngineUnavailable, Transcription

log = logging.getLogger("transcriber.fluidvoice")

MIN_TURN_SECONDS = 0.7
MAX_TURN_GAP_SECONDS = 1.5
MIN_CLIP_SECONDS = 1.5


def parse_process_payload(payload: dict) -> list[dict]:
    segments = payload.get("segments") if isinstance(payload, dict) else None
    turns: list[dict] = []
    for segment in segments or []:
        if not isinstance(segment, dict):
            continue
        try:
            start = float(
                segment.get("startTimeSeconds", segment.get("start", 0))
            )
            end = float(segment.get("endTimeSeconds", segment.get("end", 0)))
        except (TypeError, ValueError):
            continue
        if end <= start:
            continue
        turns.append(
            {
                "speaker": str(
                    segment.get("speakerId")
                    or segment.get("speaker")
                    or "Speaker"
                ),
                "start": start,
                "end": end,
            }
        )
    return turns


def parse_sortformer_payload(payload: dict) -> list[dict]:
    segments = payload.get("segments") if isinstance(payload, dict) else None
    turns: list[dict] = []
    for segment in segments or []:
        if not isinstance(segment, dict):
            continue
        try:
            start = float(segment.get("startTimeSeconds", segment.get("start", 0)))
            end = float(segment.get("endTimeSeconds", segment.get("end", 0)))
        except (TypeError, ValueError):
            continue
        if end <= start:
            continue
        turns.append(
            {
                "speaker": str(
                    segment.get("speaker")
                    or f"Speaker {segment.get('speakerIndex', 0)}"
                ),
                "start": start,
                "end": end,
            }
        )
    return turns


def parse_sortformer_output(output: str) -> list[dict]:
    turns: list[dict] = []
    for line in output.splitlines():
        match = re.match(
            r"^\s*Speaker\s+(\d+):\s*([\d.]+)s\s*-\s*([\d.]+)s",
            line,
        )
        if not match:
            continue
        start = float(match.group(2))
        end = float(match.group(3))
        if end <= start:
            continue
        turns.append(
            {"speaker": f"Speaker {match.group(1)}", "start": start, "end": end}
        )
    return turns


def merge_turns(turns: list[dict], max_speakers: int = 0) -> list[dict]:
    ordered = sorted(
        (
            turn
            for turn in turns
            if turn.get("end", 0) > turn.get("start", 0)
        ),
        key=lambda turn: (turn["start"], turn["end"]),
    )

    if max_speakers and max_speakers > 0:
        talk: dict[str, float] = {}
        for turn in ordered:
            talk[turn["speaker"]] = talk.get(turn["speaker"], 0.0) + (
                turn["end"] - turn["start"]
            )
        keep = {
            speaker
            for speaker, _ in sorted(
                talk.items(), key=lambda item: item[1], reverse=True
            )[:max_speakers]
        }
        ordered = [turn for turn in ordered if turn["speaker"] in keep]

    merged: list[dict] = []
    for turn in ordered:
        if (
            merged
            and merged[-1]["speaker"] == turn["speaker"]
            and turn["start"] - merged[-1]["end"] <= MAX_TURN_GAP_SECONDS
        ):
            merged[-1]["end"] = max(merged[-1]["end"], turn["end"])
            continue
        merged.append(dict(turn))

    kept: list[dict] = []
    for index, turn in enumerate(merged):
        duration = turn["end"] - turn["start"]
        covered = 0.0
        for other_index, other in enumerate(merged):
            if other_index == index or other["speaker"] == turn["speaker"]:
                continue
            covered += max(
                0.0,
                min(turn["end"], other["end"])
                - max(turn["start"], other["start"]),
            )
        if duration > 0 and covered / duration > 0.7 and duration < 3.0:
            continue
        kept.append(turn)

    final = [
        turn
        for turn in kept
        if turn["end"] - turn["start"] >= MIN_TURN_SECONDS
    ]

    order: list[str] = []
    for turn in final:
        if turn["speaker"] not in order:
            order.append(turn["speaker"])
    labels = {
        speaker: f"Speaker {index + 1}" for index, speaker in enumerate(order)
    }

    return [
        {
            "speaker": labels[turn["speaker"]],
            "start": round(turn["start"], 2),
            "end": round(turn["end"], 2),
        }
        for turn in final
    ]


class FluidVoiceEngine(Engine):
    """
    Uses FluidVoice's experimental local server (Settings > Experimental >
    Fluid Server) at POST /v1/transcribe. The server picks the speech model
    selected in FluidVoice (Whisper Large Turbo here).

    FluidVoice does not return a language code, so the language is inferred
    from the transcript script. Only allowed languages are kept; other calls
    are reported as skipped so an existing transcript is not overwritten.

    Mono calls are diarized with FluidAudio's CLI, then each speaker turn is
    transcribed separately. Stereo calls keep the faster channel split.
    """

    name = "fluidvoice"

    def __init__(
        self,
        base_url: str = "http://127.0.0.1:8765",
        timeout: float = 180.0,
        language: str | None = None,
        allowed_languages: list[str] | None = None,
        diarize: bool = False,
        diarizer_cli: str = "",
        diarizer: str = "process",
        diarizer_timeout: float = 900.0,
        max_speakers: int = 2,
        ffmpeg: str = "ffmpeg",
    ):
        base_url = (base_url or "").strip().rstrip("/")
        if not base_url:
            raise EngineUnavailable(
                "FLUIDVOICE_URL is not set. Enable FluidVoice > Settings > "
                "Experimental > Fluid Server and use its 127.0.0.1 port."
            )
        self.base_url = base_url
        self.timeout = timeout
        self.language = language
        self.allowed_languages = [
            code.strip().lower() for code in (allowed_languages or []) if code.strip()
        ]
        self.model = "fluid-server"
        self.diarize = bool(diarize)
        self.diarizer_cli = (
            os.path.expanduser(diarizer_cli) if diarizer_cli else ""
        )
        self.diarizer = (diarizer or "process").strip().lower()
        self.diarizer_timeout = diarizer_timeout
        self.max_speakers = max_speakers
        self.ffmpeg = ffmpeg
        self._diarizer_warned = False

    def transcribe(
        self,
        audio_path: str,
        hints: str | None = None,
        speaker: str | None = None,
    ) -> Transcription:
        info = media.probe(audio_path)
        audio = Path(audio_path).read_bytes()
        payload = self._post(audio, Path(audio_path).name)

        text = str(payload.get("text") or "").strip()
        provider = str(payload.get("provider") or "FluidVoice")
        duration = info.get("duration") or 0.0
        language = self.language or self._detect_language(payload, text)

        if self.allowed_languages and language not in self.allowed_languages:
            return Transcription(
                language=language,
                text="",
                segments=[],
                model=provider,
                engine=self.name,
                skipped=True,
            )

        if self.diarize and speaker is None:
            diarized = self._transcribe_diarized(
                audio_path, provider, language
            )
            if diarized is not None:
                return diarized

        return Transcription(
            language=language,
            text=text,
            segments=[
                {
                    "start": 0.0,
                    "end": round(float(duration), 2),
                    "text": text,
                    "speaker": speaker,
                    "language": language,
                    "confidence": (
                        float(payload["confidence"])
                        if isinstance(payload.get("confidence"), (int, float))
                        else None
                    ),
                }
            ],
            model=provider,
            engine=self.name,
        )

    def _transcribe_diarized(
        self,
        audio_path: str,
        provider: str,
        language: str,
    ) -> Transcription | None:
        turns = self._diarize(audio_path)
        if len(turns) < 2 or len({turn["speaker"] for turn in turns}) < 2:
            return None

        segments: list[dict] = []
        with tempfile.TemporaryDirectory(prefix="fv-diar-") as workdir:
            for index, turn in enumerate(turns):
                clip_path = os.path.join(workdir, f"turn-{index}.wav")
                try:
                    self._cut_turn(
                        audio_path,
                        clip_path,
                        turn["start"],
                        turn["end"],
                    )
                    payload = self._post(
                        Path(clip_path).read_bytes(), f"turn-{index}.wav"
                    )
                except Exception as error:  # noqa: BLE001 - keep other turns
                    log.warning(
                        "turn %s (%.2f-%.2f) failed: %s",
                        index,
                        turn["start"],
                        turn["end"],
                        error,
                    )
                    continue

                turn_text = str(payload.get("text") or "").strip()
                if not turn_text:
                    continue
                turn_language = self._detect_language({}, turn_text)
                if (
                    self.allowed_languages
                    and turn_language not in self.allowed_languages
                ):
                    log.info(
                        "skipping %s turn in %s",
                        turn["speaker"],
                        turn_language,
                    )
                    continue
                segments.append(
                    {
                        "start": turn["start"],
                        "end": turn["end"],
                        "text": turn_text,
                        "speaker": turn["speaker"],
                        "language": turn_language,
                        "confidence": (
                            float(payload["confidence"])
                            if isinstance(payload.get("confidence"), (int, float))
                            else None
                        ),
                    }
                )

        if not segments:
            return None

        joined = " ".join(segment["text"] for segment in segments)
        segment_languages = {
            segment.get("language")
            for segment in segments
            if segment.get("language") in ("ta", "en", "si")
        }
        detected = "mixed" if len(segment_languages) > 1 else language
        if detected in (None, "", "unknown"):
            detected = self._detect_language({}, joined)
        if (
            self.allowed_languages
            and detected != "mixed"
            and detected not in self.allowed_languages
        ):
            return Transcription(
                language=detected,
                text="",
                segments=[],
                model=provider,
                engine=self.name,
                skipped=True,
            )

        log.info(
            "diarized %d turns across %d speakers",
            len(segments),
            len({segment["speaker"] for segment in segments}),
        )
        return Transcription(
            language=detected,
            text=joined,
            segments=segments,
            model=provider,
            engine=self.name,
        )

    def _diarize(self, audio_path: str) -> list[dict]:
        if not self.diarizer_cli:
            return []
        if not Path(self.diarizer_cli).is_file():
            if not self._diarizer_warned:
                log.warning(
                    "FluidAudio CLI not found at %s; transcribing without "
                    "speaker labels",
                    self.diarizer_cli,
                )
                self._diarizer_warned = True
            return []

        if self.diarizer in ("sortformer", "auto"):
            turns = self._run_sortformer(audio_path)
            if len({turn["speaker"] for turn in turns}) >= 2:
                return merge_turns(turns, self.max_speakers)

        if self.diarizer in ("process", "clustering", "auto", "sortformer"):
            turns = self._run_process(audio_path)
            return merge_turns(turns, self.max_speakers)

        return []

    def _run_process(self, audio_path: str) -> list[dict]:
        try:
            with tempfile.TemporaryDirectory(prefix="fv-diar-") as workdir:
                output = os.path.join(workdir, "diarization.json")
                result = subprocess.run(
                    [
                        self.diarizer_cli,
                        "process",
                        audio_path,
                        "--output",
                        output,
                        "--threshold",
                        "0.7",
                    ],
                    capture_output=True,
                    text=True,
                    timeout=self.diarizer_timeout,
                )
                if result.returncode != 0:
                    log.warning(
                        "fluidaudiocli process failed (%s): %s",
                        result.returncode,
                        (result.stderr or result.stdout)[-500:],
                    )
                    return []
                raw = (
                    Path(output).read_text()
                    if Path(output).is_file()
                    else result.stdout
                )
                return parse_process_payload(json.loads(raw))
        except (
            OSError,
            subprocess.TimeoutExpired,
            json.JSONDecodeError,
        ) as error:
            log.warning("process diarization failed: %s", error)
            return []

    def _run_sortformer(self, audio_path: str) -> list[dict]:
        try:
            with tempfile.TemporaryDirectory(prefix="fv-diar-") as workdir:
                output = os.path.join(workdir, "sortformer.json")
                result = subprocess.run(
                    [
                        self.diarizer_cli,
                        "sortformer",
                        audio_path,
                        "--output",
                        output,
                    ],
                    capture_output=True,
                    text=True,
                    timeout=self.diarizer_timeout,
                )
                if result.returncode != 0:
                    log.warning(
                        "fluidaudiocli sortformer failed (%s): %s",
                        result.returncode,
                        (result.stderr or result.stdout)[-500:],
                    )
                    return []
                if Path(output).is_file():
                    try:
                        return parse_sortformer_payload(
                            json.loads(Path(output).read_text())
                        )
                    except json.JSONDecodeError as error:
                        log.warning(
                            "sortformer JSON was unreadable: %s", error
                        )
                return parse_sortformer_output(
                    f"{result.stdout}\n{result.stderr}"
                )
        except (OSError, subprocess.TimeoutExpired) as error:
            log.warning("sortformer diarization failed: %s", error)
            return []

    def _cut_turn(
        self, source: str, destination: str, start: float, end: float
    ) -> None:
        duration = max(0.0, float(end) - float(start))
        if duration <= 0:
            raise ValueError("empty speaker turn")

        filters = "highpass=f=70,loudnorm=I=-18:TP=-2"
        pad = max(0.0, MIN_CLIP_SECONDS - duration)
        if pad > 0:
            filters += f",apad=pad_dur={pad:.2f}"

        result = subprocess.run(
            [
                self.ffmpeg,
                "-y",
                "-loglevel",
                "error",
                "-ss",
                f"{float(start):.3f}",
                "-t",
                f"{duration:.3f}",
                "-i",
                source,
                "-af",
                filters,
                "-ac",
                "1",
                "-ar",
                "16000",
                "-c:a",
                "pcm_s16le",
                destination,
            ],
            capture_output=True,
            text=True,
            timeout=120,
        )
        if result.returncode != 0:
            raise RuntimeError(
                f"could not cut turn: {result.stderr.strip()[:300]}"
            )

    def _detect_language(self, payload: dict, text: str) -> str:
        for key in ("language", "languageCode", "detected_language"):
            value = payload.get(key)
            if isinstance(value, str) and value.strip():
                code = value.strip().lower()
                if code.startswith("ta"):
                    return "ta"
                if code.startswith("en"):
                    return "en"
                if code.startswith("si"):
                    return "si"
                return code

        if re.search(r"[\u0B80-\u0BFF]", text):
            return "ta"
        if re.search(r"[\u0D80-\u0DFF]", text):
            return "si"
        if re.search(r"[A-Za-z]", text):
            return "en"
        return "unknown"

    def health(self) -> dict:
        request = urllib.request.Request(
            f"{self.base_url}/v1/health",
            headers={"accept": "application/json"},
        )
        with urllib.request.urlopen(request, timeout=10) as response:
            return json.loads(response.read().decode("utf-8", "replace"))

    def _post(self, audio: bytes, filename: str) -> dict:
        raw_error: str | None = None

        try:
            return self._request(
                audio,
                "audio/wav",
            )
        except RuntimeError as error:
            raw_error = str(error)

        payload = json.dumps(
            {
                "audioBase64": base64.b64encode(audio).decode("ascii"),
                "filename": filename,
            }
        ).encode("utf-8")
        try:
            return self._request(payload, "application/json")
        except RuntimeError as error:
            raise RuntimeError(
                f"FluidVoice transcription failed (raw: {raw_error}; json: {error})"
            ) from error

    def _request(self, data: bytes, content_type: str) -> dict:
        request = urllib.request.Request(
            f"{self.base_url}/v1/transcribe",
            data=data,
            method="POST",
            headers={
                "content-type": content_type,
                "accept": "application/json",
                "user-agent": "3cx-bridge/0.1",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                body = response.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", "replace")[:400]
            raise RuntimeError(f"HTTP {error.code}: {detail}") from error
        except urllib.error.URLError as error:
            raise RuntimeError(
                f"cannot reach FluidVoice at {self.base_url}: {error.reason}"
            ) from error

        try:
            parsed = json.loads(body)
        except json.JSONDecodeError as error:
            raise RuntimeError(f"FluidVoice returned non-JSON: {body[:300]}") from error

        if not isinstance(parsed, dict):
            raise RuntimeError("FluidVoice returned an unexpected payload")
        if parsed.get("error"):
            raise RuntimeError(str(parsed["error"]))
        return parsed
