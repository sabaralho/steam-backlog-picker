"""Local FastAPI server for Steam Backlog Picker."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from fastapi import FastAPI
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
import uvicorn


BASE_DIR = Path(__file__).resolve().parent
DATA_FILE = BASE_DIR / "data" / "games.json"
FRONTEND_DIR = BASE_DIR / "frontend"

app = FastAPI(title="Steam Backlog Picker", version="1.0.0")
app.mount("/static", StaticFiles(directory=str(FRONTEND_DIR)), name="static")
if (BASE_DIR / "data").exists():
    app.mount("/data", StaticFiles(directory=str(BASE_DIR / "data")), name="data")


def _read_games_store() -> dict[str, Any]:
    """Read data/games.json from disk safely on each request."""
    if not DATA_FILE.exists():
        return {
            "updated_at": None,
            "source_file": None,
            "total_in_source": 0,
            "games_count": 0,
            "games": [],
        }
    try:
        raw = json.loads(DATA_FILE.read_text(encoding="utf-8"))
        if isinstance(raw, list):
            return {
                "updated_at": None,
                "source_file": None,
                "total_in_source": len(raw),
                "games_count": len(raw),
                "games": raw,
            }
        if isinstance(raw, dict):
            games = raw.get("games")
            if not isinstance(games, list):
                games = []
            return {
                "updated_at": raw.get("updated_at"),
                "source_file": raw.get("source_file"),
                "total_in_source": raw.get("total_in_source", len(games)),
                "games_count": len(games),
                "games": games,
            }
    except (OSError, ValueError):
        pass

    return {
        "updated_at": None,
        "source_file": None,
        "total_in_source": 0,
        "games_count": 0,
        "games": [],
    }


@app.get("/")
def serve_index() -> FileResponse:
    """Serve the minimalist dark-mode frontend."""
    return FileResponse(str(FRONTEND_DIR / "index.html"))


@app.get("/styles.css")
def serve_styles() -> FileResponse:
    """Serve CSS at root-relative path for GitHub Pages parity."""
    return FileResponse(str(FRONTEND_DIR / "styles.css"))


@app.get("/app.js")
def serve_app_js() -> FileResponse:
    """Serve JS at root-relative path for GitHub Pages parity."""
    return FileResponse(str(FRONTEND_DIR / "app.js"))


@app.get("/api/games")
def get_games() -> JSONResponse:
    """Return enriched games list along with computed genres and category counts."""
    store = _read_games_store()
    games = store["games"]

    genres_set: set[str] = set()
    category_counts = {"familia": 0, "gratuito": 0, "excluido": 0}
    for game in games:
        if not isinstance(game, dict):
            continue
        cat = game.get("category")
        if cat in category_counts:
            category_counts[cat] += 1
        for genre in game.get("genres") or []:
            if isinstance(genre, str) and genre.strip():
                genres_set.add(genre.strip())

    payload = {
        "updated_at": store["updated_at"],
        "source_file": store["source_file"],
        "total_in_source": store["total_in_source"],
        "games_count": len(games),
        "available_genres": sorted(genres_set, key=str.casefold),
        "category_counts": category_counts,
        "games": games,
    }
    return JSONResponse(content=payload)


@app.get("/api/health")
def health_check() -> dict[str, Any]:
    """Health check endpoint reporting loaded game count."""
    store = _read_games_store()
    return {"status": "ok", "games_loaded": len(store["games"])}


def main() -> None:
    parser = argparse.ArgumentParser(description="Inicia o servidor web local do Steam Backlog Picker.")
    parser.add_argument("--host", default="127.0.0.1", help="Endereço de escuta (padrão: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=8000, help="Porta HTTP (padrão: 8000)")
    args = parser.parse_args()
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
