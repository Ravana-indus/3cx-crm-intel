from __future__ import annotations

import math
import struct
import tempfile
import unittest
import wave
from pathlib import Path

from transcriber import media


def write_stereo_wav(path: Path, duration: float = 1.0, rate: int = 8000) -> None:
    frames = int(duration * rate)
    data = bytearray()
    for index in range(frames):
        value = int(3000 * math.sin(2 * math.pi * 440 * index / rate))
        data += struct.pack("<h", value)
        data += struct.pack("<h", value)

    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(2)
        handle.setsampwidth(2)
        handle.setframerate(rate)
        handle.writeframes(bytes(data))


class MediaTests(unittest.TestCase):
    def test_probe_and_convert_stereo(self) -> None:
        with tempfile.TemporaryDirectory() as workdir:
            source = Path(workdir) / "stereo.wav"
            write_stereo_wav(source)

            info = media.probe(source)
            self.assertEqual(info["channels"], 2)
            self.assertAlmostEqual(info["duration"] or 0.0, 1.0, delta=0.15)

            mono = Path(workdir) / "mono.wav"
            media.to_mono_16k(source, mono)
            mono_info = media.probe(mono)
            self.assertEqual(mono_info["channels"], 1)
            self.assertEqual(mono_info["sample_rate"], 16000)

            left, right = media.split_channels(source, workdir)
            self.assertEqual(media.probe(left)["channels"], 1)
            self.assertEqual(media.probe(right)["channels"], 1)


if __name__ == "__main__":
    unittest.main()
