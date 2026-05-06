import asyncio
import os
import tempfile
import logging
from functools import lru_cache
from pathlib import Path
from typing import Any

import httpx
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from google.auth.transport import requests as google_requests
from google.oauth2 import id_token
from openai import OpenAI
from sqlalchemy import Boolean, Column, DateTime, Float, MetaData, String, Table, create_engine, func, select, text
from sqlalchemy.engine import Engine


BASE_DIR = Path(__file__).resolve().parent
DB_PATH = BASE_DIR.parent / "app.db"
DATABASE_URL = os.getenv("DATABASE_URL", "").strip()
DEFAULT_MINUTES = 30.0
ADMIN_EMAIL = os.getenv("ADMIN_EMAIL", "theoder@gmail.com").lower()
GOOGLE_CLIENT_ID = os.getenv("GOOGLE_CLIENT_ID", "")
SESSION_SECRET = os.getenv("SESSION_SECRET", "change-this-in-production")
WORKER_TRANSCRIBE_URL = os.getenv("WORKER_TRANSCRIBE_URL", "https://speech-transcribe-worker.theoder.workers.dev")
MAX_FILE_SIZE_MB = int(os.getenv("MAX_AUDIO_FILE_MB", "25"))
MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024
AUDIO_EXTENSIONS = {".mp3", ".wav", ".m4a"}
TXT_TRANSCRIBE_MODEL = "gpt-4o-mini-transcribe"
SRT_TRANSCRIBE_MODEL = "whisper-1"
LANGUAGE_CODES = {
    "auto": None,
    "zh": "zh",
    "en": "en",
    "ja": "ja",
    "ko": "ko",
}
LANGUAGE_PROMPTS = {
    "zh": "請使用繁體中文（台灣用字）輸出。",
}

app = FastAPI(title="Speech to TXT/SRT")
templates = Jinja2Templates(directory=str(BASE_DIR / "templates"))
app.mount("/static", StaticFiles(directory=str(BASE_DIR / "static")), name="static")
metadata = MetaData()

users_table = Table(
    "users",
    metadata,
    Column("email", String, primary_key=True),
    Column("name", String, nullable=False, server_default=""),
    Column("remaining_minutes", Float, nullable=False, server_default=text("30")),
    Column("is_admin", Boolean, nullable=False, server_default=text("false")),
    Column("created_at", DateTime, nullable=False, server_default=func.now()),
    Column("updated_at", DateTime, nullable=False, server_default=func.now()),
)


def build_engine() -> Engine:
    if DATABASE_URL:
        return create_engine(DATABASE_URL, pool_pre_ping=True, future=True)
    sqlite_url = f"sqlite:///{DB_PATH}"
    return create_engine(sqlite_url, connect_args={"check_same_thread": False}, future=True)


engine = build_engine()
logger = logging.getLogger(__name__)


def init_db() -> None:
    metadata.create_all(engine)


@app.on_event("startup")
def startup() -> None:
    try:
        init_db()
    except Exception as exc:
        # Do not crash the whole app at boot; surface DB issues on API calls instead.
        logger.exception("Database initialization failed during startup: %s", exc)


def format_srt_timestamp(seconds: float) -> str:
    total_ms = round(seconds * 1000)
    hours = total_ms // 3_600_000
    total_ms %= 3_600_000
    minutes = total_ms // 60_000
    total_ms %= 60_000
    secs = total_ms // 1000
    ms = total_ms % 1000
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{ms:03d}"


def get_payload_value(item: Any, key: str, default: Any = None) -> Any:
    if isinstance(item, dict):
        return item.get(key, default)
    return getattr(item, key, default)


def build_srt(segments: list[Any]) -> str:
    lines: list[str] = []
    for index, segment in enumerate(segments, start=1):
        start = float(get_payload_value(segment, "start", 0))
        end = float(get_payload_value(segment, "end", start))
        text = str(get_payload_value(segment, "text", "")).strip()
        if not text:
            continue
        lines.append(str(index))
        lines.append(f"{format_srt_timestamp(start)} --> {format_srt_timestamp(end)}")
        lines.append(text)
        lines.append("")
    return "\n".join(lines).strip() + "\n"


def extract_audio_minutes(payload: dict[str, Any]) -> float:
    segments = payload.get("segments") or []
    max_end = 0.0
    for seg in segments:
        end = float(get_payload_value(seg, "end", 0) or 0)
        if end > max_end:
            max_end = end
    if max_end <= 0:
        duration = float(payload.get("duration", 0) or 0)
        max_end = duration
    return max(0.0, max_end / 60.0)


def parse_transcription_payload(payload: dict[str, Any]) -> tuple[dict[str, str], float]:
    text = str(payload.get("text", "")).strip()
    srt = str(payload.get("srt", "")).strip()
    if not srt:
        segments = payload.get("segments") or []
        srt = build_srt(segments)
    if not text:
        raise HTTPException(status_code=500, detail="Transcription finished but got empty text.")
    if not srt:
        srt = "1\n00:00:00,000 --> 00:00:10,000\n" + text + "\n"
    return {"text": text, "srt": srt if srt.endswith("\n") else f"{srt}\n"}, extract_audio_minutes(payload)


def is_allowed_audio_file(file: UploadFile) -> bool:
    filename = (file.filename or "").lower()
    suffix = Path(filename).suffix
    content_type = (file.content_type or "").lower()
    return suffix in AUDIO_EXTENSIONS or content_type in {"audio/mpeg", "audio/wav", "audio/x-wav", "audio/mp4", "audio/m4a"}


def normalize_language(language: str) -> str | None:
    language_key = (language or "auto").strip().lower()
    if language_key not in LANGUAGE_CODES:
        raise HTTPException(status_code=400, detail="Unsupported audio language.")
    return LANGUAGE_CODES[language_key]


@lru_cache(maxsize=1)
def get_traditional_chinese_converter() -> Any:
    try:
        from opencc import OpenCC
    except ImportError as exc:
        raise HTTPException(
            status_code=500,
            detail="Traditional Chinese conversion dependency is not installed.",
        ) from exc
    return OpenCC("s2twp")


def to_traditional_chinese(text: str) -> str:
    return get_traditional_chinese_converter().convert(text)


def get_current_email(request: Request) -> str | None:
    return request.cookies.get("session_email")


def get_current_user(request: Request, require_admin: bool = False) -> dict[str, Any]:
    email = get_current_email(request)
    if not email:
        raise HTTPException(status_code=401, detail="Please sign in first.")
    with engine.begin() as conn:
        row = conn.execute(select(users_table).where(users_table.c.email == email.lower())).mappings().first()
    if not row:
        raise HTTPException(status_code=401, detail="User not found.")
    if require_admin and not bool(row["is_admin"]):
        raise HTTPException(status_code=403, detail="Admin permission required.")
    return dict(row)


def upsert_user(email: str, name: str) -> dict[str, Any]:
    normalized_email = email.lower()
    is_admin = 1 if email.lower() == ADMIN_EMAIL else 0
    with engine.begin() as conn:
        existing = conn.execute(
            select(users_table.c.email).where(users_table.c.email == normalized_email)
        ).first()
        if existing:
            conn.execute(
                users_table.update()
                .where(users_table.c.email == normalized_email)
                .values(name=name, is_admin=bool(is_admin), updated_at=func.now())
            )
        else:
            conn.execute(
                users_table.insert().values(
                    email=normalized_email,
                    name=name,
                    remaining_minutes=DEFAULT_MINUTES,
                    is_admin=bool(is_admin),
                )
            )
        row = conn.execute(
            select(users_table).where(users_table.c.email == normalized_email)
        ).mappings().first()
    return dict(row) if row else {}


def verify_google_credential(credential: str) -> dict[str, Any]:
    if not credential:
        raise HTTPException(status_code=400, detail="Missing Google credential.")
    if not GOOGLE_CLIENT_ID:
        raise HTTPException(status_code=500, detail="Server missing GOOGLE_CLIENT_ID.")

    try:
        info = id_token.verify_oauth2_token(
            credential,
            google_requests.Request(),
            GOOGLE_CLIENT_ID,
        )
    except Exception as exc:
        raise HTTPException(status_code=401, detail=f"Google sign-in verification failed: {exc}") from exc

    email = str(info.get("email", "")).lower()
    if not email:
        raise HTTPException(status_code=401, detail="Google account email is unavailable.")
    name = str(info.get("name", email))
    return upsert_user(email=email, name=name)


def set_session_cookies(response: JSONResponse | RedirectResponse, email: str, secure: bool = False) -> None:
    response.set_cookie("session_email", email, httponly=True, samesite="lax", secure=secure)
    response.set_cookie("session_sig", SESSION_SECRET, httponly=True, samesite="lax", secure=secure)


def serialize_user(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "email": row["email"],
        "name": row["name"],
        "remaining_minutes": round(float(row["remaining_minutes"]), 2),
        "is_admin": bool(row["is_admin"]),
    }


def serialize_admin_user(row: dict[str, Any]) -> dict[str, Any]:
    return {
        **serialize_user(row),
        "created_at": row["created_at"].isoformat() if row.get("created_at") else "",
        "updated_at": row["updated_at"].isoformat() if row.get("updated_at") else "",
    }


async def transcribe_via_worker(
    file_bytes: bytes,
    filename: str,
    content_type: str,
    model: str,
    language: str | None,
    response_format: str = "json",
    prompt: str | None = None,
) -> tuple[dict[str, str], float]:

    async def call_worker(form_data: dict[str, str]) -> httpx.Response:
        try:
            async with httpx.AsyncClient(timeout=300.0) as client:
                return await client.post(
                    WORKER_TRANSCRIBE_URL,
                    data=form_data,
                    files={"file": (filename, file_bytes, content_type)},
                )
        except httpx.RequestError as exc:
            raise HTTPException(status_code=502, detail=f"Worker service unavailable: {exc}") from exc

    # Try multiple compatible keys because different Worker versions read different field names.
    form_data = {"model": model, "response_format": response_format}
    if language:
        form_data["language"] = language
    if prompt:
        form_data["prompt"] = prompt
    response = await call_worker(form_data)
    if response.status_code >= 400:
        detail = response.text
        try:
            body = response.json()
            if isinstance(body, dict):
                detail = str(body.get("detail", detail))
        except Exception:
            pass
        if "response_format 'verbose_json' is not compatible" in detail.lower():
            fallback_form_data = {"model": model, "format": "json", "output_format": "json"}
            if language:
                fallback_form_data["language"] = language
            if prompt:
                fallback_form_data["prompt"] = prompt
            response = await call_worker(fallback_form_data)
            if response.status_code >= 400:
                detail = response.text
                try:
                    body = response.json()
                    if isinstance(body, dict):
                        detail = str(body.get("detail", detail))
                except Exception:
                    pass
        if response.status_code >= 400:
            raise HTTPException(status_code=response.status_code, detail=detail)

    payload = response.json()
    if not isinstance(payload, dict):
        raise HTTPException(status_code=500, detail="Worker response format is invalid.")
    return parse_transcription_payload(payload)


@app.get("/", response_class=HTMLResponse)
async def home(request: Request) -> HTMLResponse:
    return templates.TemplateResponse(
        "index.html",
        {"request": request, "google_client_id": GOOGLE_CLIENT_ID, "max_file_mb": MAX_FILE_SIZE_MB},
    )


@app.post("/api/auth/google")
async def auth_google(request: Request) -> JSONResponse:
    body = await request.json()
    credential = body.get("credential", "")
    user = verify_google_credential(credential)
    response = JSONResponse({"user": serialize_user(user)})
    set_session_cookies(response, user["email"], secure=request.url.scheme == "https")
    return response


@app.post("/api/auth/google/redirect")
async def auth_google_redirect(
    request: Request,
    credential: str = Form(...),
    g_csrf_token: str | None = Form(None),
) -> RedirectResponse:
    cookie_csrf_token = request.cookies.get("g_csrf_token")
    if g_csrf_token or cookie_csrf_token:
        if not g_csrf_token or not cookie_csrf_token or g_csrf_token != cookie_csrf_token:
            raise HTTPException(status_code=400, detail="Google sign-in CSRF check failed.")
    user = verify_google_credential(credential)
    response = RedirectResponse(url="/", status_code=303)
    set_session_cookies(response, user["email"], secure=request.url.scheme == "https")
    return response


@app.post("/api/logout")
async def logout() -> JSONResponse:
    response = JSONResponse({"ok": True})
    response.delete_cookie("session_email")
    response.delete_cookie("session_sig")
    return response


@app.get("/api/me")
async def me(request: Request) -> dict[str, Any]:
    sig = request.cookies.get("session_sig")
    if sig != SESSION_SECRET:
        return {"user": None}
    email = get_current_email(request)
    if not email:
        return {"user": None}
    with engine.begin() as conn:
        row = conn.execute(select(users_table).where(users_table.c.email == email.lower())).mappings().first()
    if not row:
        return {"user": None}
    return {"user": serialize_user(dict(row))}


@app.post("/api/admin/set-minutes")
async def admin_set_minutes(
    request: Request,
    email: str = Form(...),
    minutes: float = Form(...),
) -> dict[str, Any]:
    sig = request.cookies.get("session_sig")
    if sig != SESSION_SECRET:
        raise HTTPException(status_code=401, detail="Please sign in first.")
    _admin = get_current_user(request, require_admin=True)
    target_email = email.strip().lower()
    if not target_email:
        raise HTTPException(status_code=400, detail="Target email is required.")
    safe_minutes = max(0.0, float(minutes))
    with engine.begin() as conn:
        existing = conn.execute(
            select(users_table.c.email).where(users_table.c.email == target_email)
        ).first()
        if not existing:
            conn.execute(
                users_table.insert().values(
                    email=target_email,
                    name=target_email,
                    remaining_minutes=safe_minutes,
                    is_admin=bool(target_email == ADMIN_EMAIL),
                )
            )
        else:
            conn.execute(
                users_table.update()
                .where(users_table.c.email == target_email)
                .values(remaining_minutes=safe_minutes, updated_at=func.now())
            )
        updated = conn.execute(
            select(users_table).where(users_table.c.email == target_email)
        ).mappings().first()
    return {"user": serialize_user(dict(updated))}


@app.get("/api/admin/users")
async def admin_users(request: Request) -> dict[str, Any]:
    sig = request.cookies.get("session_sig")
    if sig != SESSION_SECRET:
        raise HTTPException(status_code=401, detail="Please sign in first.")
    _admin = get_current_user(request, require_admin=True)
    with engine.begin() as conn:
        rows = conn.execute(select(users_table).order_by(users_table.c.updated_at.desc())).mappings().all()
    return {"users": [serialize_admin_user(dict(row)) for row in rows]}


@app.post("/api/transcribe")
async def transcribe(
    request: Request,
    file: UploadFile = File(...),
    language: str = Form("auto"),
) -> dict[str, Any]:
    sig = request.cookies.get("session_sig")
    if sig != SESSION_SECRET:
        raise HTTPException(status_code=401, detail="Please sign in with Google first.")
    user = get_current_user(request)
    if float(user["remaining_minutes"]) <= 0:
        raise HTTPException(status_code=403, detail="No remaining minutes. Please contact admin.")
    if not is_allowed_audio_file(file):
        raise HTTPException(status_code=400, detail="Only mp3, wav, and m4a are supported.")
    language_code = normalize_language(language)
    language_prompt = LANGUAGE_PROMPTS.get(language_code or "")

    file_size = 0
    file_chunks: list[bytes] = []
    while True:
        chunk = await file.read(1024 * 1024)
        if not chunk:
            break
        file_size += len(chunk)
        if file_size > MAX_FILE_SIZE_BYTES:
            raise HTTPException(status_code=400, detail=f"File is too large. Limit is {MAX_FILE_SIZE_MB} MB.")
        file_chunks.append(chunk)
    file_bytes = b"".join(file_chunks)
    filename = file.filename or "upload.bin"
    content_type = file.content_type or "application/octet-stream"

    if WORKER_TRANSCRIBE_URL:
        (txt_parsed, txt_minutes), (srt_parsed, srt_minutes) = await asyncio.gather(
            transcribe_via_worker(
                file_bytes=file_bytes,
                filename=filename,
                content_type=content_type,
                model=TXT_TRANSCRIBE_MODEL,
                language=language_code,
                response_format="json",
                prompt=language_prompt,
            ),
            transcribe_via_worker(
                file_bytes=file_bytes,
                filename=filename,
                content_type=content_type,
                model=SRT_TRANSCRIBE_MODEL,
                language=language_code,
                response_format="verbose_json",
                prompt=language_prompt,
            ),
        )
        parsed = {"text": txt_parsed["text"], "srt": srt_parsed["srt"]}
        used_minutes = max(txt_minutes, srt_minutes)
    else:
        final_api_key = os.getenv("OPENAI_API_KEY")
        if not final_api_key:
            raise HTTPException(status_code=400, detail="No available transcription backend.")

        suffix = Path(file.filename or "audio").suffix or ".tmp"
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            tmp_path = Path(tmp.name)
            tmp.write(file_bytes)

        try:
            client = OpenAI(api_key=final_api_key)
            language_kwargs = {"language": language_code} if language_code else {}
            prompt_kwargs = {"prompt": language_prompt} if language_prompt else {}
            with tmp_path.open("rb") as audio_file:
                txt_result = client.audio.transcriptions.create(
                    model=TXT_TRANSCRIBE_MODEL,
                    file=audio_file,
                    response_format="json",
                    **language_kwargs,
                    **prompt_kwargs,
                )
            with tmp_path.open("rb") as audio_file:
                srt_result = client.audio.transcriptions.create(
                    model=SRT_TRANSCRIBE_MODEL,
                    file=audio_file,
                    response_format="verbose_json",
                    **language_kwargs,
                    **prompt_kwargs,
                )
            txt_payload = {"text": getattr(txt_result, "text", None)}
            srt_payload = {
                "text": getattr(srt_result, "text", None),
                "segments": getattr(srt_result, "segments", None),
                "duration": getattr(srt_result, "duration", None),
            }
            txt_parsed, txt_minutes = parse_transcription_payload(txt_payload)
            srt_parsed, srt_minutes = parse_transcription_payload(srt_payload)
            parsed = {"text": txt_parsed["text"], "srt": srt_parsed["srt"]}
            used_minutes = max(txt_minutes, srt_minutes)
        finally:
            if tmp_path.exists():
                tmp_path.unlink()

    if language_code == "zh":
        parsed = {
            "text": to_traditional_chinese(parsed["text"]),
            "srt": to_traditional_chinese(parsed["srt"]),
        }

    remaining = max(0.0, float(user["remaining_minutes"]) - used_minutes)
    with engine.begin() as conn:
        conn.execute(
            users_table.update()
            .where(users_table.c.email == user["email"])
            .values(remaining_minutes=remaining, updated_at=func.now())
        )
    return {"text": parsed["text"], "srt": parsed["srt"], "used_minutes": round(used_minutes, 2), "remaining_minutes": round(remaining, 2)}
