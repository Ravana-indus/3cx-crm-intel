from __future__ import annotations

from .. import media
from .base import Engine, EngineUnavailable, Transcription


class NemoEngine(Engine):
    """
    NVIDIA Parakeet via NeMo. Parakeet checkpoints are usually single-language,
    so this engine is only selected for Tamil (see AutoEngine) or used directly
    with TRANSCRIBER_ENGINE=nemo.
    """

    name = "nemo"

    def __init__(self, model_path: str | None = None, model_name: str | None = None):
        try:
            import nemo.collections.asr as nemo_asr
        except ImportError as exc:  # pragma: no cover - optional dependency
            raise EngineUnavailable(
                "nemo_toolkit is not installed. Run "
                "pip install 'nemo_toolkit[asr]' or set TRANSCRIBER_ENGINE=whisper."
            ) from exc

        self._asr = nemo_asr
        if model_path:
            self._model = nemo_asr.models.ASRModel.restore_from(model_path)
            self.model_name = model_path
        else:
            self.model_name = model_name or "nvidia/parakeet-tdt-0.6b-v2"
            self._model = nemo_asr.models.ASRModel.from_pretrained(
                model_name=self.model_name
            )

    @property
    def model(self) -> str:
        return self.model_name

    def transcribe(
        self,
        audio_path: str,
        hints: str | None = None,
        speaker: str | None = None,
    ) -> Transcription:
        outputs = self._model.transcribe(
            [audio_path], return_hypotheses=True
        )
        text = ""
        if outputs:
            first = outputs[0]
            text = (getattr(first, "text", None) or str(first)).strip()

        try:
            duration = media.probe(audio_path).get("duration") or 0.0
        except Exception:
            duration = 0.0

        return Transcription(
            language="ta",
            text=text,
            segments=[
                {
                    "start": 0.0,
                    "end": round(float(duration), 2),
                    "text": text,
                    "speaker": speaker,
                }
            ],
            model=self.model_name,
            engine=self.name,
        )
