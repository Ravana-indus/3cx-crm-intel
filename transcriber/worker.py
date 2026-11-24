from __future__ import annotations

import logging
import os
import tempfile
import time

from . import media
from .client import BridgeClient
from .config import Config
from .engines import build_engine

log = logging.getLogger("transcriber")


def merge_channel_results(left, right) -> dict:
    available = [
        result
        for result in (left, right)
        if not getattr(result, "skipped", False)
    ]
    if not available:
        return {
            "language": left.language or right.language,
            "text": "",
            "segments": [],
            "model": left.model or right.model,
            "engine": left.engine or right.engine,
            "skipped": True,
        }

    if len(available) == 1:
        result = available[0]
        return {
            "language": result.language,
            "text": result.text,
            "segments": result.segments,
            "model": result.model,
            "engine": result.engine,
            "skipped": False,
        }

    segments = sorted(
        left.segments + right.segments,
        key=lambda segment: (
            segment.get("start", 0.0),
            0 if segment.get("speaker") == "caller" else 1,
        ),
    )
    text = " ".join(
        segment.get("text", "").strip()
        for segment in segments
        if segment.get("text", "").strip()
    )
    language = (
        left.language
        if left.language not in (None, "", "unknown")
        else right.language
    )
    segment_languages = {
        segment.get("language")
        for segment in segments
        if segment.get("language") in ("ta", "en", "si")
    }
    if len(segment_languages) > 1:
        language = "mixed"
    return {
        "language": language,
        "text": text,
        "segments": segments,
        "model": left.model or right.model,
        "engine": left.engine or right.engine,
        "skipped": False,
    }


def process_job(client: BridgeClient, engine, job: dict, config: Config, workdir: str) -> dict:
    audio_path = os.path.join(workdir, "source.wav")
    client.download(job["audio_url"], audio_path)

    info = media.probe(audio_path, ffprobe=config.ffprobe)
    channels = info.get("channels") or 1
    hints = job.get("hints")

    if config.diarise and channels >= 2:
        caller_path, agent_path = media.split_channels(
            audio_path, workdir, ffmpeg=config.ffmpeg
        )
        caller = engine.transcribe(caller_path, hints=hints, speaker="caller")
        agent = engine.transcribe(agent_path, hints=hints, speaker="agent")
        result = merge_channel_results(caller, agent)
    else:
        mono_path = media.to_mono_16k(
            audio_path,
            os.path.join(workdir, "mono16k.wav"),
            ffmpeg=config.ffmpeg,
        )
        transcription = engine.transcribe(mono_path, hints=hints)
        result = {
            "language": transcription.language,
            "text": transcription.text,
            "segments": transcription.segments,
            "model": transcription.model,
            "engine": transcription.engine,
            "skipped": getattr(transcription, "skipped", False),
        }

    if result.get("skipped"):
        client.report(
            job["id"],
            {
                "status": "skipped",
                "engine": result["engine"],
                "model": result["model"],
                "language": result["language"],
                "reason": "language_not_allowed",
            },
        )
        log.info(
            "job %s skipped: language=%s",
            job.get("id"),
            result.get("language"),
        )
        return result

    client.report(
        job["id"],
        {
            "status": "ok",
            "engine": result["engine"],
            "model": result["model"],
            "language": result["language"],
            "text": result["text"],
            "segments": result["segments"],
        },
    )
    return result


def run(config: Config, max_jobs: int = 0) -> int:
    client = BridgeClient(config.bridge_url, config.worker_token)
    engine = build_engine(config)
    log.info(
        "transcriber started (engine=%s model=%s bridge=%s)",
        engine.name,
        engine.model,
        config.bridge_url,
    )

    processed = 0
    while True:
        try:
            job = client.claim("transcribe")
        except Exception as exc:  # noqa: BLE001 - bridge may be restarting
            log.warning("could not claim a job: %s", exc)
            if max_jobs:
                break
            time.sleep(config.poll_seconds)
            continue

        if not job:
            if max_jobs:
                break
            time.sleep(config.poll_seconds)
            continue

        try:
            with tempfile.TemporaryDirectory(prefix="3cx-transcriber-") as workdir:
                result = process_job(client, engine, job, config, workdir)
            log.info(
                "job %s transcribed: %s segments in %s",
                job.get("id"),
                len(result.get("segments") or []),
                result.get("language"),
            )
        except Exception as exc:  # noqa: BLE001 - report every failure to the bridge
            log.exception("job %s failed", job.get("id"))
            try:
                client.report(
                    job["id"],
                    {"status": "error", "error": str(exc)[:900]},
                )
            except Exception:  # noqa: BLE001
                log.exception("could not report failure for job %s", job.get("id"))

        processed += 1
        if max_jobs and processed >= max_jobs:
            break

    return processed
