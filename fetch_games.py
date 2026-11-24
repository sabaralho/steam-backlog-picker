"""Fetch and enrich Steam Family games metadata into an incrementally cached JSON store."""

from __future__ import annotations

import argparse
import asyncio
from datetime import datetime, timezone
from difflib import SequenceMatcher
import html
import json
import os
from pathlib import Path
import re
import sys
import time
from typing import Any
from urllib.parse import quote

import httpx
from howlongtobeatpy import HowLongToBeat


if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")


SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_INPUT_LOCAL = SCRIPT_DIR / "jogos_familia_steam.txt"
DEFAULT_INPUT_DOCS = Path(r"C:\Users\Pichau\OneDrive\Documentos\jogos_familia_steam.txt")
DEFAULT_OUTPUT = SCRIPT_DIR / "data" / "games.json"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/131.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9,pt-BR;q=0.8",
}

SECTION_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"^===\s*JOGOS INCLU[ÍI]DOS NA FAM[ÍI]LIA STEAM.*===$", re.IGNORECASE), "familia"),
    (re.compile(r"^===\s*JOGOS EXCLU[ÍI]DOS.*===$", re.IGNORECASE), "excluido"),
    (re.compile(r"^===\s*JOGOS GRATUITOS.*===$", re.IGNORECASE), "gratuito"),
]
COPY_SUFFIX_RE = re.compile(r"\s*\((\d+)x\)\s*$", re.IGNORECASE)

BLOCK_TAG_RE = re.compile(r"<(?:br\s*/?|/?(?:li|p|div|tr|ul|ol|strong|b))\b[^>]*>", re.IGNORECASE)
ANY_TAG_RE = re.compile(r"<[^>]+>")

STORAGE_PATTERN_A = re.compile(
    r"(?:Storage|Hard\s*Drive|Hard\s*Disk(?:\s*Space)?|Disk\s*Space|"
    r"Armazenamento|Espa[çc]o\s+em\s+disco|Disco\s+r[íi]gido|HD)"
    r"\s*[:\-]?\s*[^.;\n]{0,45}?(\d+(?:[.,]\d+)?)\s*(TB|GB|GiB|MB|MiB)\b",
    re.IGNORECASE,
)
STORAGE_PATTERN_B = re.compile(
    r"(\d+(?:[.,]\d+)?)\s*(TB|GB|GiB|MB|MiB)\s+(?:of\s+)?"
    r"(?:available|free|hard\s*(?:drive|disk)|disk|HD|de\s+espa[çc]o|espa[çc]o\s+dispon[íi]vel)",
    re.IGNORECASE,
)

NOISE_TOKENS = {
    "soundtrack",
    "ost",
    "dlc",
    "demo",
    "playtest",
    "season pass",
    "artbook",
    "art book",
    "upgrade",
    "bundle",
    "pack",
    "wallpaper",
    "supporter",
}


class RateLimiter:
    """Async per-domain rate limiter enforcing minimum interval between requests."""

    def __init__(self, min_interval: float) -> None:
        self.min_interval = max(0.0, min_interval)
        self._lock = asyncio.Lock()
        self._last_ts = 0.0

    async def wait(self) -> None:
        async with self._lock:
            now = time.monotonic()
            elapsed = now - self._last_ts
            if elapsed < self.min_interval:
                await asyncio.sleep(self.min_interval - elapsed)
            self._last_ts = time.monotonic()


def parse_games_txt(path: Path) -> list[dict[str, Any]]:
    """Parse jogos_familia_steam.txt into structured game entries preserving category and copies."""
    content = path.read_text(encoding="utf-8-sig")
    entries: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    current_category: str | None = None

    for raw_line in content.splitlines():
        line = raw_line.strip()
        if not line:
            continue

        matched_section = False
        for pattern, category_name in SECTION_PATTERNS:
            if pattern.match(line):
                current_category = category_name
                matched_section = True
                break
        if matched_section:
            continue

        if current_category is None:
            current_category = "familia"

        copies = 1
        copy_match = COPY_SUFFIX_RE.search(line)
        if copy_match:
            copies = int(copy_match.group(1))
            clean_name = line[: copy_match.start()].strip()
        else:
            clean_name = line

        game_id = f"{current_category}:{clean_name.casefold()}"
        if game_id in seen_ids:
            continue
        seen_ids.add(game_id)

        entries.append(
            {
                "id": game_id,
                "name": clean_name,
                "raw_name": line,
                "category": current_category,
                "copies": copies,
            }
        )

    return entries


def _html_to_lines(raw_html: str) -> str:
    """Convert Steam requirement HTML snippets into newline-separated plain text."""
    text = BLOCK_TAG_RE.sub("\n", raw_html)
    text = ANY_TAG_RE.sub(" ", text)
    text = html.unescape(text)
    lines = [re.sub(r"\s+", " ", ln).strip() for ln in text.splitlines()]
    return "\n".join(ln for ln in lines if ln)


def _unit_to_gb(number_str: str, unit: str) -> float | None:
    """Convert extracted storage string and unit to gigabytes."""
    value = float(number_str.replace(",", "."))
    unit_lower = unit.lower()
    if unit_lower == "tb":
        gb = value * 1024.0
    elif unit_lower in ("gb", "gib"):
        gb = value
    elif unit_lower in ("mb", "mib"):
        gb = value / 1024.0
    else:
        return None

    if gb <= 0 or gb > 1000:
        return None
    return round(gb, 2)


def extract_disk_size_gb(pc_requirements: Any) -> tuple[float | None, str | None]:
    """Extract estimated disk storage in GB from Steam pc_requirements without matching RAM."""
    if not isinstance(pc_requirements, dict):
        return None, None

    candidates_by_bucket: dict[str, list[tuple[float, str]]] = {
        "recommended": [],
        "minimum": [],
    }

    for bucket in ("recommended", "minimum"):
        raw_html = pc_requirements.get(bucket)
        if not isinstance(raw_html, str) or not raw_html.strip():
            continue

        plain_text = _html_to_lines(raw_html)
        for line in plain_text.splitlines():
            for pattern in (STORAGE_PATTERN_A, STORAGE_PATTERN_B):
                match = pattern.search(line)
                if match:
                    gb_val = _unit_to_gb(match.group(1), match.group(2))
                    if gb_val is not None:
                        raw_str = f"{match.group(1).replace(',', '.')} {match.group(2).upper()}"
                        candidates_by_bucket[bucket].append((gb_val, raw_str))
                    break

    preferred = candidates_by_bucket["recommended"] or candidates_by_bucket["minimum"]
    if not preferred:
        return None, None

    best_gb, best_raw = max(preferred, key=lambda item: item[0])
    return best_gb, best_raw


def _normalize_title(title: str) -> str:
    """Normalize a game title for resilient fuzzy comparison."""
    cleaned = title.replace("™", "").replace("®", "").replace("©", "")
    cleaned = cleaned.replace("–", "-").replace("—", "-").replace("’", "'").replace("`", "'")
    cleaned = re.sub(r"[^\w\s]", " ", cleaned.casefold())
    return re.sub(r"\s+", " ", cleaned).strip()


def _sanitize_query(name: str) -> str:
    """Sanitize a game name for Steam Store search queries."""
    cleaned = name.replace("™", "").replace("®", "").replace("©", "")
    cleaned = cleaned.replace("–", "-").replace("—", "-").replace("’", "'").replace("`", "'")
    return re.sub(r"\s+", " ", cleaned).strip()


def _score_candidate(query: str, candidate: str) -> float:
    """Score similarity between query and candidate while penalizing DLC/OST noise."""
    norm_q = _normalize_title(query)
    norm_c = _normalize_title(candidate)
    if not norm_q or not norm_c:
        return 0.0
    if norm_q == norm_c:
        return 1.0

    score = SequenceMatcher(None, norm_q, norm_c).ratio()
    if norm_q in norm_c or norm_c in norm_q:
        score = max(score, 0.86 - abs(len(norm_c) - len(norm_q)) * 0.004)

    for token in NOISE_TOKENS:
        if token in norm_c and token not in norm_q:
            score -= 0.35
            break

    return max(0.0, min(1.0, score))


async def _request_json(
    client: httpx.AsyncClient,
    limiter: RateLimiter,
    url: str,
    params: dict[str, Any] | None = None,
    retries: int = 5,
) -> tuple[Any, bool]:
    """Perform an HTTP GET returning (parsed_json, ok) with rate limiting and backoff."""
    backoff_429 = (10, 25, 45, 60, 60)
    for attempt in range(retries):
        await limiter.wait()
        try:
            resp = await client.get(url, params=params)
            if resp.status_code == 429:
                retry_after = resp.headers.get("Retry-After")
                if retry_after and retry_after.isdigit():
                    wait_s = min(float(retry_after), 90.0)
                else:
                    wait_s = float(backoff_429[min(attempt, len(backoff_429) - 1)])
                print(f"  [429] aguardando {int(wait_s)}s...", flush=True)
                await asyncio.sleep(wait_s)
                continue
            if resp.status_code >= 500:
                await asyncio.sleep(min(1.5 * (2**attempt), 15.0))
                continue
            if resp.status_code != 200:
                return None, False
            return resp.json(), True
        except ValueError:
            return None, False
        except httpx.RequestError:
            await asyncio.sleep(min(1.0 * (2**attempt), 15.0))
    return None, False


def _pick_best_steam_match(
    query: str,
    candidates: list[tuple[int, str]],
) -> tuple[int | None, str | None, float]:
    """Select the highest-scoring Steam search result above the threshold."""
    best_appid: int | None = None
    best_name: str | None = None
    best_score = 0.0
    for appid, cand_name in candidates:
        score = _score_candidate(query, cand_name)
        if score > best_score:
            best_score = score
            best_appid = appid
            best_name = cand_name
    if best_score >= 0.50:
        return best_appid, best_name, best_score
    return None, None, best_score


async def search_steam_appid(
    client: httpx.AsyncClient,
    limiter: RateLimiter,
    clean_name: str,
) -> tuple[int | None, str]:
    """Search Steam Store (EN -> PT-BR -> SearchApps) for an appid. Returns (appid, status)."""
    queries = [_sanitize_query(clean_name)]
    stripped_paren = re.sub(r"\s*\([^)]*\)\s*$", "", queries[0]).strip()
    if stripped_paren and stripped_paren != queries[0]:
        queries.append(stripped_paren)

    best_overall: tuple[int | None, float] = (None, 0.0)
    any_ok = False

    for q in queries:
        for lang, cc in (("english", "US"), ("portuguese", "BR")):
            data, ok = await _request_json(
                client,
                limiter,
                "https://store.steampowered.com/api/storesearch/",
                params={"term": q, "l": lang, "cc": cc},
            )
            if ok:
                any_ok = True
                items = (data or {}).get("items") or []
                candidates = [
                    (int(item["id"]), str(item.get("name", "")))
                    for item in items
                    if isinstance(item, dict) and item.get("id") and item.get("name")
                ]
                appid, _, score = _pick_best_steam_match(q, candidates)
                if appid is not None and score > best_overall[1]:
                    best_overall = (appid, score)
                if best_overall[1] >= 0.85:
                    return best_overall[0], "ok"

        # Fallback for delisted/retired titles via Steam Community SearchApps
        if best_overall[1] < 0.70:
            encoded_q = quote(q, safe="")
            data, ok = await _request_json(
                client,
                limiter,
                f"https://steamcommunity.com/actions/SearchApps/{encoded_q}",
            )
            if ok and isinstance(data, list):
                any_ok = True
                candidates = [
                    (int(item["appid"]), str(item.get("name", "")))
                    for item in data
                    if isinstance(item, dict) and item.get("appid") and item.get("name")
                ]
                appid, _, score = _pick_best_steam_match(q, candidates)
                if appid is not None and score > best_overall[1]:
                    best_overall = (appid, score)
                if best_overall[1] >= 0.85:
                    return best_overall[0], "ok"

    if best_overall[0] is not None:
        return best_overall[0], "ok"
    return None, "not_found" if any_ok else "failed"


async def fetch_steam_details(
    client: httpx.AsyncClient,
    limiter: RateLimiter,
    appid: int,
) -> tuple[dict[str, Any], str]:
    """Fetch Steam appdetails and extract metadata + disk size in GB."""
    app_data: dict[str, Any] | None = None
    any_ok = False

    for lang, cc in (("english", "US"), ("portuguese", "BR")):
        data, ok = await _request_json(
            client,
            limiter,
            "https://store.steampowered.com/api/appdetails",
            params={"appids": str(appid), "l": lang, "cc": cc},
        )
        if not ok or not isinstance(data, dict):
            continue
        any_ok = True
        entry = data.get(str(appid))
        if isinstance(entry, dict) and entry.get("success") and isinstance(entry.get("data"), dict):
            app_data = entry["data"]
            break

    if app_data is None:
        return {}, "not_found" if any_ok else "failed"

    disk_gb, disk_raw = extract_disk_size_gb(app_data.get("pc_requirements"))
    genres = [
        str(g["description"]).strip()
        for g in (app_data.get("genres") or [])
        if isinstance(g, dict) and g.get("description")
    ]
    categories = [
        str(c["description"]).strip()
        for c in (app_data.get("categories") or [])
        if isinstance(c, dict) and c.get("description")
    ]
    header_image = app_data.get("header_image") or (
        f"https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/{appid}/header.jpg"
    )
    recommendations = app_data.get("recommendations")
    rec_total = (
        int(recommendations["total"])
        if isinstance(recommendations, dict) and isinstance(recommendations.get("total"), int)
        else None
    )
    release_info = app_data.get("release_date")
    release_date = (
        str(release_info.get("date")).strip()
        if isinstance(release_info, dict) and release_info.get("date")
        else None
    )
    metacritic = app_data.get("metacritic")
    metacritic_score = (
        int(metacritic["score"])
        if isinstance(metacritic, dict) and isinstance(metacritic.get("score"), int)
        else None
    )
    metacritic_url = (
        str(metacritic["url"]).strip()
        if isinstance(metacritic, dict) and metacritic.get("url")
        else None
    )

    details = {
        "steam_name": app_data.get("name"),
        "header_image": header_image,
        "store_url": f"https://store.steampowered.com/app/{appid}/",
        "steam_uri": f"steam://store/{appid}",
        "genres": genres,
        "categories": categories,
        "disk_size_gb": disk_gb,
        "disk_size_raw": disk_raw,
        "release_date": release_date,
        "short_description": app_data.get("short_description"),
        "recommendations_total": rec_total,
        "metacritic_score": metacritic_score,
        "metacritic_url": metacritic_url,
    }
    return details, "ok"


def _review_score_label(rating_pct: float | None, total_reviews: int) -> str | None:
    """Derive a Portuguese Steam review summary label from rating percentage and count."""
    if rating_pct is None or total_reviews <= 0:
        return None
    if rating_pct >= 95.0 and total_reviews >= 500:
        return "Extremamente positivas"
    if rating_pct >= 80.0 and total_reviews >= 50:
        return "Muito positivas"
    if rating_pct >= 80.0:
        return "Positivas"
    if rating_pct >= 70.0:
        return "Ligeiramente positivas"
    if rating_pct >= 40.0:
        return "Neutras"
    return "Negativas"


async def fetch_steam_reviews(
    client: httpx.AsyncClient,
    limiter: RateLimiter,
    appid: int,
) -> tuple[dict[str, Any], str]:
    """Fetch aggregate Steam user review percentage and review counts via appreviewhistogram."""
    data, ok = await _request_json(
        client,
        limiter,
        f"https://store.steampowered.com/appreviewhistogram/{appid}",
        params={"l": "english"},
    )
    if not ok or not isinstance(data, dict) or data.get("success") != 1:
        return {}, "failed"

    results = data.get("results") or {}
    buckets = results.get("rollups") or []
    if not buckets:
        buckets = results.get("recent") or []

    total_positive = sum(int(b.get("recommendations_up") or 0) for b in buckets if isinstance(b, dict))
    total_negative = sum(int(b.get("recommendations_down") or 0) for b in buckets if isinstance(b, dict))
    total_reviews = total_positive + total_negative

    rating_pct = round((total_positive / total_reviews) * 100.0, 1) if total_reviews > 0 else None
    score_desc = _review_score_label(rating_pct, total_reviews)

    return (
        {
            "steam_rating_pct": rating_pct,
            "steam_review_total": total_reviews,
            "steam_review_positive": total_positive,
            "steam_review_desc": score_desc,
        },
        "ok",
    )


def _hltb_queries(clean_name: str, steam_name: str | None) -> list[str]:
    """Build ordered, deduplicated candidate queries for HowLongToBeat."""
    raw_candidates: list[str] = []
    if steam_name:
        raw_candidates.append(steam_name)
    raw_candidates.append(clean_name)

    for base in list(raw_candidates):
        sanitized = _sanitize_query(base)
        raw_candidates.append(sanitized)
        no_year = re.sub(r"\s*\(\d{4}\)\s*$", "", sanitized).strip()
        raw_candidates.append(no_year)
        no_edition = re.sub(
            r"\s*[:\-]\s*(?:Definitive|Ultimate|Enhanced|Complete|Special|Game of the Year|GOTY|Remastered)\s*Edition\s*$",
            "",
            no_year,
            flags=re.IGNORECASE,
        ).strip()
        raw_candidates.append(no_edition)

    seen: set[str] = set()
    unique: list[str] = []
    for item in raw_candidates:
        if item and item.casefold() not in seen:
            seen.add(item.casefold())
            unique.append(item)
    return unique


def _positive_hours(val: Any) -> float | None:
    """Normalize HLTB duration values, treating <= 0 as unknown (None)."""
    if isinstance(val, (int, float)) and val > 0:
        return round(float(val), 1)
    return None


async def fetch_hltb(
    limiter: RateLimiter,
    semaphore: asyncio.Semaphore,
    clean_name: str,
    steam_name: str | None = None,
) -> tuple[dict[str, Any], str]:
    """Query HowLongToBeat asynchronously with similarity validation and safe fallbacks."""
    queries = _hltb_queries(clean_name, steam_name)
    any_succeeded = False

    for query in queries:
        async with semaphore:
            await limiter.wait()
            try:
                results = await HowLongToBeat().async_search(query)
                any_succeeded = True
            except Exception:
                continue

        if not results:
            continue

        best = max(results, key=lambda el: getattr(el, "similarity", 0.0) or 0.0)
        sim = getattr(best, "similarity", 0.0) or 0.0
        if sim < 0.55:
            continue

        game_id = getattr(best, "game_id", None)
        return (
            {
                "main_story_hours": _positive_hours(getattr(best, "main_story", None)),
                "main_extra_hours": _positive_hours(getattr(best, "main_extra", None)),
                "hltb_completionist_hours": _positive_hours(getattr(best, "completionist", None)),
                "hltb_game_name": getattr(best, "game_name", None),
                "hltb_url": f"https://howlongtobeat.com/game/{game_id}" if game_id else None,
            },
            "ok",
        )

    return {}, "not_found" if any_succeeded else "failed"


def _empty_game_record(entry: dict[str, Any]) -> dict[str, Any]:
    """Create a normalized base record for a parsed game entry."""
    return {
        "id": entry["id"],
        "name": entry["name"],
        "raw_name": entry["raw_name"],
        "category": entry["category"],
        "copies": entry["copies"],
        "appid": None,
        "steam_name": None,
        "header_image": None,
        "store_url": None,
        "steam_uri": None,
        "steam_rating_pct": None,
        "steam_review_total": None,
        "steam_review_positive": None,
        "steam_review_desc": None,
        "metacritic_score": None,
        "metacritic_url": None,
        "genres": [],
        "categories": [],
        "disk_size_gb": None,
        "disk_size_raw": None,
        "release_date": None,
        "short_description": None,
        "main_story_hours": None,
        "main_extra_hours": None,
        "hltb_completionist_hours": None,
        "hltb_game_name": None,
        "hltb_url": None,
        "fetch_status": {
            "steam_search": "pending",
            "steam_details": "pending",
            "steam_reviews": "pending",
            "hltb": "pending",
        },
        "updated_at": None,
    }


def _needs_retry(record: dict[str, Any]) -> dict[str, bool]:
    """Identify which enrichment stages are missing or failed for an existing record."""
    fs = record.get("fetch_status") or {}
    need_search = record.get("appid") is None or fs.get("steam_search") in ("failed", "not_found", "pending", None)
    need_details = need_search or fs.get("steam_details") != "ok" or (
        record.get("appid") is not None and "metacritic_score" not in record
    )
    need_reviews = need_search or fs.get("steam_reviews") in ("failed", "pending", None)
    need_hltb = fs.get("hltb") in ("failed", "not_found", "pending", None)
    return {
        "search": need_search,
        "details": need_details,
        "reviews": need_reviews,
        "hltb": need_hltb,
    }


def load_cache(output_path: Path) -> dict[str, dict[str, Any]]:
    """Load previously cached games keyed by game ID."""
    if not output_path.exists():
        return {}
    try:
        payload = json.loads(output_path.read_text(encoding="utf-8"))
        games = payload.get("games") if isinstance(payload, dict) else payload
        if not isinstance(games, list):
            return {}
        return {
            str(g["id"]): g
            for g in games
            if isinstance(g, dict) and g.get("id")
        }
    except (OSError, ValueError):
        return {}


def save_cache(
    output_path: Path,
    source_entries: list[dict[str, Any]],
    records_by_id: dict[str, dict[str, Any]],
    source_file_name: str,
) -> None:
    """Atomically write the full games database preserving source order."""
    output_path.parent.mkdir(parents=True, exist_ok=True)

    ordered_games: list[dict[str, Any]] = []
    included_ids: set[str] = set()
    for entry in source_entries:
        gid = entry["id"]
        if gid in records_by_id:
            ordered_games.append(records_by_id[gid])
            included_ids.add(gid)

    for gid, rec in records_by_id.items():
        if gid not in included_ids:
            ordered_games.append(rec)

    payload = {
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "source_file": source_file_name,
        "total_in_source": len(source_entries),
        "games_count": len(ordered_games),
        "games": ordered_games,
    }

    tmp_path = output_path.with_suffix(".json.tmp")
    tmp_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp_path, output_path)


def _format_progress_summary(rec: dict[str, Any]) -> str:
    """Format concise per-game progress metrics for terminal output."""
    parts: list[str] = []
    if rec.get("steam_rating_pct") is not None and rec.get("steam_review_total") is not None:
        parts.append(f"Steam: {rec['steam_rating_pct']}% / {rec['steam_review_total']:,}")
    elif rec.get("appid") is not None:
        parts.append(f"AppID: {rec['appid']}")
    else:
        parts.append("Steam: N/A")

    if rec.get("metacritic_score") is not None:
        parts.append(f"MC: {rec['metacritic_score']}")

    if rec.get("disk_size_gb") is not None:
        parts.append(f"{rec['disk_size_gb']} GB")

    if rec.get("main_story_hours") is not None:
        parts.append(f"HLTB: {rec['main_story_hours']}h")

    return " | ".join(parts)


async def enrich_games(args: argparse.Namespace) -> None:
    """Run incremental parsing, Steam enrichment, HLTB lookup, and atomic persistence."""
    input_path = Path(args.input)
    if not input_path.exists() and input_path == DEFAULT_INPUT_LOCAL and DEFAULT_INPUT_DOCS.exists():
        input_path = DEFAULT_INPUT_DOCS

    if not input_path.exists():
        print(f"Erro: arquivo de entrada não encontrado: {input_path}", file=sys.stderr)
        sys.exit(1)

    output_path = Path(args.output)
    source_entries = parse_games_txt(input_path)
    target_entries = source_entries[: args.limit] if args.limit and args.limit > 0 else source_entries
    records_by_id = load_cache(output_path)

    steam_limiter = RateLimiter(args.delay)
    hltb_limiter = RateLimiter(max(0.6, args.delay))
    hltb_semaphore = asyncio.Semaphore(1)

    total = len(target_entries)
    stats = {
        "cached": 0,
        "processed": 0,
        "steam_found": 0,
        "disk_found": 0,
        "hltb_found": 0,
        "errors": 0,
    }

    print(f"Fonte: {input_path} ({len(source_entries)} jogos no arquivo)", flush=True)
    print(f"Alvo desta execução: {total} jogos | Cache existente: {len(records_by_id)} jogos\n", flush=True)

    async with httpx.AsyncClient(headers=HEADERS, timeout=15.0, follow_redirects=True) as client:
        for idx, entry in enumerate(target_entries, start=1):
            gid = entry["id"]
            existing = records_by_id.get(gid)

            if existing is not None and not args.retry_missing:
                # Sync metadata from .txt (e.g. copy count or category) without calling APIs
                existing["copies"] = entry["copies"]
                existing["category"] = entry["category"]
                existing["raw_name"] = entry["raw_name"]
                stats["cached"] += 1
                print(f"[{idx:02d}/{total}] {entry['name']} - CACHED", flush=True)
                continue

            if existing is not None:
                needs = _needs_retry(existing)
                if not any(needs.values()):
                    stats["cached"] += 1
                    print(f"[{idx:02d}/{total}] {entry['name']} - CACHED", flush=True)
                    continue
                rec = dict(existing)
                rec["fetch_status"] = dict(existing.get("fetch_status") or {})
            else:
                rec = _empty_game_record(entry)
                needs = {"search": True, "details": True, "reviews": True, "hltb": True}

            stats["processed"] += 1

            # 1. Steam Search
            if needs["search"]:
                appid, search_status = await search_steam_appid(client, steam_limiter, entry["name"])
                rec["appid"] = appid
                rec["fetch_status"]["steam_search"] = search_status
                if appid is None:
                    rec["fetch_status"]["steam_details"] = "skipped"
                    rec["fetch_status"]["steam_reviews"] = "skipped"

            # 2. Steam Details (needed first so steam_name is available for HLTB)
            if rec.get("appid") is not None and needs["details"]:
                appid = int(rec["appid"])
                details, details_status = await fetch_steam_details(client, steam_limiter, appid)
                rec["fetch_status"]["steam_details"] = details_status
                if details:
                    rec.update(details)

            # 3. Steam Reviews & HowLongToBeat concurrently per game
            async def _run_reviews() -> None:
                if rec.get("appid") is None or not needs["reviews"]:
                    return
                reviews, reviews_status = await fetch_steam_reviews(client, steam_limiter, int(rec["appid"]))
                rec["fetch_status"]["steam_reviews"] = reviews_status
                if reviews:
                    rec.update(reviews)
                    if rec.get("steam_review_total") is None and rec.get("recommendations_total"):
                        rec["steam_review_total"] = rec["recommendations_total"]

            async def _run_hltb() -> None:
                if not needs["hltb"]:
                    return
                hltb_data, hltb_status = await fetch_hltb(
                    hltb_limiter,
                    hltb_semaphore,
                    entry["name"],
                    steam_name=rec.get("steam_name"),
                )
                rec["fetch_status"]["hltb"] = hltb_status
                if hltb_data:
                    rec.update(hltb_data)

            await asyncio.gather(_run_reviews(), _run_hltb())

            rec.setdefault("metacritic_score", None)
            rec.setdefault("metacritic_url", None)
            rec["updated_at"] = datetime.now(timezone.utc).isoformat()
            records_by_id[gid] = rec
            save_cache(output_path, source_entries, records_by_id, input_path.name)

            if rec.get("appid") is not None:
                stats["steam_found"] += 1
            if rec.get("disk_size_gb") is not None:
                stats["disk_found"] += 1
            if rec.get("main_story_hours") is not None:
                stats["hltb_found"] += 1

            fs = rec["fetch_status"]
            has_error = any(v == "failed" for v in fs.values())
            if has_error:
                stats["errors"] += 1

            tag = "OK" if rec.get("appid") is not None and not has_error else "PARTIAL"
            print(f"[{idx:02d}/{total}] {entry['name']} - {tag} ({_format_progress_summary(rec)})", flush=True)

    # Ensure cache metadata stays synced even if all games were cached
    if stats["processed"] == 0 and records_by_id:
        save_cache(output_path, source_entries, records_by_id, input_path.name)

    print("\n--- Resumo ---")
    print(f"Total verificado: {total} | Pulados (cache): {stats['cached']} | Coletados/atualizados: {stats['processed']}")
    if stats["processed"] > 0:
        print(
            f"Novos resultados -> Steam ID: {stats['steam_found']} | "
            f"Disco (GB): {stats['disk_found']} | HLTB: {stats['hltb_found']} | Falhas parciais: {stats['errors']}"
        )
    print(f"Banco salvo em: {output_path} ({len(records_by_id)} jogos no total)")


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Coleta dados da Steam e HowLongToBeat para o Steam Backlog Picker.")
    parser.add_argument("--input", default=str(DEFAULT_INPUT_LOCAL), help="Caminho para jogos_familia_steam.txt")
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT), help="Caminho para data/games.json")
    parser.add_argument("--limit", type=int, default=None, help="Limita a quantidade de jogos processados")
    parser.add_argument(
        "--retry-missing",
        action="store_true",
        help="Reprocessa apenas campos ausentes/com erro em jogos já presentes no cache",
    )
    parser.add_argument(
        "--delay",
        type=float,
        default=0.45,
        help="Intervalo mínimo (segundos) entre requisições por domínio (padrão: 0.45)",
    )
    return parser


if __name__ == "__main__":
    cli_args = build_arg_parser().parse_args()
    asyncio.run(enrich_games(cli_args))
