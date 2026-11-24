#!/usr/bin/env python3
"""Entry point: python3 -m transcriber.main [--once] [--check] [--engine mock]"""

from __future__ import annotations

import argparse
import dataclasses
import json
import logging
import os
import sys

from .config import Config
from .engines import build_engine
from .worker import run


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="3CX transcription worker")
    parser.add_argument(
        "--once",
        action="store_true",
        help="process at most one job, then exit",
    )
    parser.add_argument(
        "--engine",
        choices=["mock", "fluidvoice", "whisper", "nemo", "auto"],
        help="override TRANSCRIBER_ENGINE for this run",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="load the engine, print its identity, then exit",
    )
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=os.environ.get("LOG_LEVEL", "INFO"),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )

    config = Config.from_env()
    if args.engine:
        config = dataclasses.replace(config, engine=args.engine)

    if args.check:
        engine = build_engine(config)
        print(json.dumps({"engine": engine.name, "model": engine.model}))
        return 0

    processed = run(
        config, max_jobs=1 if args.once else config.max_jobs
    )
    print(f"processed {processed} job(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
