# Voice awareness prototype

A prosthetic for self-awareness. Live mode gives a gentle haptic nudge on your phone when you drift outside the safe vocal zone. Training mode records a short session, then plays it back with coaching, emotion, and volume overlaid.

## Run it

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
# fill in SPEECHMATICS_API_KEY and THYMIA_API_KEY
# ensure Ollama is running and the model is pulled:
#   ollama serve
#   ollama pull gemma4:e4b
python app.py
```

Then open:
- Dashboard: http://localhost:8000/
- Phone (same wifi or hotspot): http://LAN-IP:8000/phone
- Training: http://localhost:8000/train
- Review: /review/{session_id} after a training session

## Test the training pipeline offline

```bash
python test_training.py sessions/test_session_001/
```

The folder must contain `audio.wav` (or `audio.webm`) and optionally `video.webm`. Output lands in `report.json`.

## Layout

- `app.py` — web app, WebSockets, routes
- `config.json` — all thresholds and tuning
- `services/` — pluggable Protocol-based adapters
- `templates/`, `static/` — frontend
- `sessions/` — one folder per training session

All secrets live in `.env`. Never commit it.
