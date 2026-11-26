# playalong.cz – RunPod Serverless worker (Demucs + WhisperX + doby/akordy)
FROM runpod/pytorch:2.4.0-py3.11-cuda12.4.1-devel-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive PYTHONUNBUFFERED=1 HF_HOME=/models/hf TORCH_HOME=/models/torch
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir -U whisperx demucs runpod numpy

# modely předem do image (rychlejší studený start): Demucs, česky align model, Whisper large-v3
RUN python -c "from demucs.pretrained import get_model; get_model('htdemucs')" \
 && python -c "import whisperx; whisperx.load_align_model(language_code='cs', device='cpu')" \
 && python -c "from faster_whisper.utils import download_model; download_model('large-v3')"

WORKDIR /app
COPY pipeline.py handler.py ./
CMD ["python", "-u", "handler.py"]
