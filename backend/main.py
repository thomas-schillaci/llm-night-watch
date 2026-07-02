import asyncio
import json
import shutil
import sqlite3
import subprocess
import time
import uuid
from pathlib import Path
from typing import AsyncIterator
from urllib.parse import urljoin, urlparse

import httpx
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field


APP_DIR = Path(__file__).resolve().parent
PROJECT_DIR = APP_DIR.parent
CONFIG_PATH = PROJECT_DIR / "llm-night-watch.config.json"
DEFAULT_VLLM_URL = "http://localhost:8000"
DEFAULT_VLLM_MODEL = "auto"
DEFAULT_VLLM_API_KEY = "EMPTY"
DEFAULT_VLLM_IMAGE = "vllm/vllm-openai:latest"
DEFAULT_TEE_DB_PATH = "llm-night-watch.sqlite3"
DEFAULT_MAX_BODY_BYTES = 1_000_000
HOP_BY_HOP_HEADERS = {
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
}

app = FastAPI(title="LLM Night Watch")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class VllmConfig(BaseModel):
    url: str = DEFAULT_VLLM_URL
    model: str = DEFAULT_VLLM_MODEL
    api_key: str = DEFAULT_VLLM_API_KEY
    image: str = DEFAULT_VLLM_IMAGE


class ProxyConfig(BaseModel):
    base_url: str = DEFAULT_VLLM_URL
    api_key: str = DEFAULT_VLLM_API_KEY
    capture_bodies: bool = True
    max_body_bytes: int = DEFAULT_MAX_BODY_BYTES
    db_path: str = DEFAULT_TEE_DB_PATH


class AppConfig(BaseModel):
    vllm: VllmConfig = Field(default_factory=VllmConfig)
    proxy: ProxyConfig = Field(default_factory=ProxyConfig)


class VllmModelStatus(BaseModel):
    configured: str = DEFAULT_VLLM_MODEL
    resolved: str = ""
    auto_detect: bool = True
    models: list[str] = []
    detail: str = ""
    error: str = ""


class GpuStatus(BaseModel):
    detected: bool = False
    devices: list[str] = []
    error: str = ""


class ConfigStatus(BaseModel):
    app_config: AppConfig
    model: VllmModelStatus
    gpu: GpuStatus


class ProxyTestRequest(BaseModel):
    base_url: str
    api_key: str = DEFAULT_VLLM_API_KEY


class ProxyTestResult(BaseModel):
    ok: bool
    models: list[str] = []
    detail: str = ""
    error: str = ""


class TeeRecord(BaseModel):
    request_id: str
    started_at: float
    method: str
    path: str
    query_string: str
    model: str
    status_code: int | None = None
    latency_ms: float | None = None
    error: str = ""
    request_body: bytes | None = None
    response_body: bytes | None = None
    request_truncated: bool = False
    response_truncated: bool = False


class RequestSummary(BaseModel):
    request_id: str
    started_at: float
    method: str
    path: str
    query_string: str
    model: str
    status_code: int | None = None
    latency_ms: float | None = None
    elapsed_ms: float | None = None
    error: str = ""
    request_body: str | None = None
    response_body: str | None = None
    request_truncated: bool = False
    response_truncated: bool = False
    running: bool = False


class RequestsResponse(BaseModel):
    active: list[RequestSummary]
    saved: list[RequestSummary]


active_requests: dict[str, TeeRecord] = {}
active_requests_lock = asyncio.Lock()


def normalize_vllm_url(url: str) -> str:
    normalized = url.strip().rstrip("/")
    if normalized.endswith("/v1"):
        normalized = normalized[:-3].rstrip("/")
    return normalized or DEFAULT_VLLM_URL


def normalize_body_limit(value: int) -> int:
    return max(0, min(value, 50_000_000))


def normalize_db_path(path: str) -> str:
    normalized = path.strip() or DEFAULT_TEE_DB_PATH
    candidate = Path(normalized)
    if candidate.is_absolute():
        return str(candidate)
    return str(PROJECT_DIR / candidate)


def resolve_vllm_url(vllm_url: str, backend_base_url: str | None = None) -> str:
    normalized = normalize_vllm_url(vllm_url)
    parsed = urlparse(normalized)
    if parsed.scheme and parsed.netloc:
        return normalized
    if backend_base_url:
        return urljoin(str(backend_base_url), normalized)
    return normalized


def vllm_api_base_url(vllm_url: str, backend_base_url: str | None = None) -> str:
    return urljoin(f"{resolve_vllm_url(vllm_url, backend_base_url).rstrip('/')}/", "v1")


def normalize_app_config(config: AppConfig) -> AppConfig:
    config.vllm.url = normalize_vllm_url(config.vllm.url)
    config.vllm.model = config.vllm.model.strip() or DEFAULT_VLLM_MODEL
    config.vllm.api_key = config.vllm.api_key.strip() or DEFAULT_VLLM_API_KEY
    config.vllm.image = config.vllm.image.strip() or DEFAULT_VLLM_IMAGE
    config.proxy.base_url = normalize_vllm_url(config.proxy.base_url or config.vllm.url)
    config.proxy.api_key = config.proxy.api_key.strip() or config.vllm.api_key
    config.proxy.max_body_bytes = normalize_body_limit(config.proxy.max_body_bytes)
    config.proxy.db_path = normalize_db_path(config.proxy.db_path)
    return config


def read_app_config() -> AppConfig:
    if not CONFIG_PATH.exists():
        return normalize_app_config(AppConfig())

    try:
        raw = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        return normalize_app_config(AppConfig.model_validate(raw))
    except (OSError, json.JSONDecodeError, ValueError) as exc:
        raise HTTPException(status_code=500, detail=f"Could not read config file: {exc}") from exc


def write_app_config(config: AppConfig) -> AppConfig:
    normalized = normalize_app_config(config)
    try:
        CONFIG_PATH.write_text(normalized.model_dump_json(indent=2) + "\n", encoding="utf-8")
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Could not write config file: {exc}") from exc
    return normalized


async def detect_vllm_models(config: AppConfig, backend_base_url: str | None = None) -> list[str]:
    models_url = urljoin(f"{vllm_api_base_url(config.vllm.url, backend_base_url).rstrip('/')}/", "models")
    async with httpx.AsyncClient(timeout=5) as client:
        response = await client.get(models_url, headers={"Authorization": f"Bearer {config.vllm.api_key}"})
        response.raise_for_status()

    payload = response.json()
    data = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(data, list):
        return []

    models: list[str] = []
    for item in data:
        if isinstance(item, dict):
            model_id = str(item.get("id", "")).strip()
            if model_id:
                models.append(model_id)
    return models


async def detect_proxy_models(base_url: str, api_key: str) -> list[str]:
    models_url = urljoin(f"{normalize_vllm_url(base_url).rstrip('/')}/", "v1/models")
    async with httpx.AsyncClient(timeout=5, transport=get_upstream_transport()) as client:
        response = await client.get(
            models_url,
            headers={"Authorization": f"Bearer {api_key.strip() or DEFAULT_VLLM_API_KEY}"},
        )
        response.raise_for_status()

    payload = response.json()
    data = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(data, list):
        return []

    models: list[str] = []
    for item in data:
        if isinstance(item, dict):
            model_id = str(item.get("id", "")).strip()
            if model_id:
                models.append(model_id)
    return models


async def vllm_model_status(config: AppConfig, backend_base_url: str | None = None) -> VllmModelStatus:
    configured = config.vllm.model.strip() or DEFAULT_VLLM_MODEL
    auto_detect = configured.lower() == "auto"
    if not auto_detect:
        return VllmModelStatus(configured=configured, resolved=configured, auto_detect=False, detail="Using configured model")

    try:
        models = await detect_vllm_models(config, backend_base_url)
    except httpx.HTTPError as exc:
        return VllmModelStatus(configured=configured, auto_detect=True, error=str(exc))

    if not models:
        return VllmModelStatus(configured=configured, auto_detect=True, error="/v1/models returned no model ids")
    return VllmModelStatus(
        configured=configured,
        resolved=models[0],
        auto_detect=True,
        models=models,
        detail=f"Auto-detected {models[0]}",
    )


def run_command(command: list[str], timeout: int = 5) -> subprocess.CompletedProcess[str]:
    return subprocess.run(command, capture_output=True, check=False, text=True, timeout=timeout)


def gpu_status() -> GpuStatus:
    if shutil.which("nvidia-smi") is None:
        return GpuStatus(detected=False, error="nvidia-smi command not found")

    try:
        result = run_command(["nvidia-smi", "--query-gpu=name", "--format=csv,noheader"], timeout=5)
    except (OSError, subprocess.TimeoutExpired) as exc:
        return GpuStatus(detected=False, error=str(exc))

    if result.returncode != 0:
        return GpuStatus(detected=False, error=(result.stderr or result.stdout).strip())

    devices = [line.strip() for line in result.stdout.splitlines() if line.strip()]
    return GpuStatus(detected=bool(devices), devices=devices, error="" if devices else "No NVIDIA GPU reported")


def get_upstream_transport() -> httpx.AsyncBaseTransport | None:
    return getattr(app.state, "upstream_transport", None)


def capture_body(body: bytes, enabled: bool, max_bytes: int) -> tuple[bytes | None, bool]:
    if not enabled:
        return None, False
    if len(body) <= max_bytes:
        return body, False
    return body[:max_bytes], True


def extract_model(body: bytes) -> str:
    if not body:
        return ""
    try:
        payload = json.loads(body)
    except json.JSONDecodeError:
        return ""
    if not isinstance(payload, dict):
        return ""
    model = payload.get("model")
    return str(model).strip() if model is not None else ""


def init_tee_db(db_path: str) -> None:
    path = Path(db_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(path) as connection:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS openai_request_tee (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                request_id TEXT NOT NULL,
                started_at REAL NOT NULL,
                method TEXT NOT NULL,
                path TEXT NOT NULL,
                query_string TEXT NOT NULL,
                model TEXT NOT NULL,
                status_code INTEGER,
                latency_ms REAL,
                error TEXT NOT NULL,
                request_body BLOB,
                response_body BLOB,
                request_truncated INTEGER NOT NULL,
                response_truncated INTEGER NOT NULL
            )
            """,
        )
        connection.execute("CREATE INDEX IF NOT EXISTS idx_openai_request_tee_request_id ON openai_request_tee(request_id)")
        connection.execute("CREATE INDEX IF NOT EXISTS idx_openai_request_tee_started_at ON openai_request_tee(started_at)")


def write_tee_record(db_path: str, record: TeeRecord) -> None:
    init_tee_db(db_path)
    with sqlite3.connect(db_path) as connection:
        connection.execute(
            """
            INSERT INTO openai_request_tee (
                request_id,
                started_at,
                method,
                path,
                query_string,
                model,
                status_code,
                latency_ms,
                error,
                request_body,
                response_body,
                request_truncated,
                response_truncated
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                record.request_id,
                record.started_at,
                record.method,
                record.path,
                record.query_string,
                record.model,
                record.status_code,
                record.latency_ms,
                record.error,
                record.request_body,
                record.response_body,
                int(record.request_truncated),
                int(record.response_truncated),
            ),
        )


async def safe_write_tee_record(db_path: str, record: TeeRecord) -> None:
    try:
        await asyncio.to_thread(write_tee_record, db_path, record)
    except Exception as exc:
        print(f"Could not write OpenAI tee record {record.request_id}: {exc}")


async def track_active_request(record: TeeRecord) -> None:
    async with active_requests_lock:
        active_requests[record.request_id] = record.model_copy(deep=True)


async def update_active_request(record: TeeRecord) -> None:
    async with active_requests_lock:
        if record.request_id in active_requests:
            active_requests[record.request_id] = record.model_copy(deep=True)


async def remove_active_request(request_id: str) -> None:
    async with active_requests_lock:
        active_requests.pop(request_id, None)


def decode_body(body: bytes | None) -> str | None:
    if body is None:
        return None
    return body.decode("utf-8", errors="replace")


def summarize_record(record: TeeRecord, running: bool = False) -> RequestSummary:
    return RequestSummary(
        request_id=record.request_id,
        started_at=record.started_at,
        method=record.method,
        path=record.path,
        query_string=record.query_string,
        model=record.model,
        status_code=record.status_code,
        latency_ms=record.latency_ms,
        elapsed_ms=(time.time() - record.started_at) * 1000 if running else None,
        error=record.error,
        request_body=decode_body(record.request_body),
        response_body=decode_body(record.response_body),
        request_truncated=record.request_truncated,
        response_truncated=record.response_truncated,
        running=running,
    )


def summarize_saved_row(row: sqlite3.Row) -> RequestSummary:
    return RequestSummary(
        request_id=row["request_id"],
        started_at=row["started_at"],
        method=row["method"],
        path=row["path"],
        query_string=row["query_string"],
        model=row["model"],
        status_code=row["status_code"],
        latency_ms=row["latency_ms"],
        error=row["error"],
        request_body=decode_body(row["request_body"]),
        response_body=decode_body(row["response_body"]),
        request_truncated=bool(row["request_truncated"]),
        response_truncated=bool(row["response_truncated"]),
        running=False,
    )


def list_saved_tee_records(db_path: str, limit: int) -> list[RequestSummary]:
    init_tee_db(db_path)
    with sqlite3.connect(db_path) as connection:
        connection.row_factory = sqlite3.Row
        rows = connection.execute(
            """
            SELECT *
            FROM openai_request_tee
            ORDER BY started_at DESC, id DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()
    return [summarize_saved_row(row) for row in rows]


async def list_active_request_summaries() -> list[RequestSummary]:
    async with active_requests_lock:
        records = [record.model_copy(deep=True) for record in active_requests.values()]
    return sorted((summarize_record(record, running=True) for record in records), key=lambda item: item.started_at, reverse=True)


def upstream_headers(request: Request, api_key: str) -> dict[str, str]:
    headers: dict[str, str] = {}
    incoming_auth = ""
    for name, value in request.headers.items():
        lowered = name.lower()
        if lowered in HOP_BY_HOP_HEADERS or lowered in {"host", "content-length"}:
            continue
        if lowered == "authorization":
            incoming_auth = value
            continue
        headers[name] = value

    headers["Authorization"] = incoming_auth or f"Bearer {api_key}"
    return headers


def response_headers(headers: httpx.Headers) -> dict[str, str]:
    return {name: value for name, value in headers.items() if name.lower() not in HOP_BY_HOP_HEADERS}


def proxy_upstream_url(base_url: str, path: str) -> str:
    return urljoin(f"{normalize_vllm_url(base_url).rstrip('/')}/", f"v1/{path}")


async def proxy_openai_request(path: str, request: Request) -> Response:
    config = read_app_config()
    proxy = config.proxy
    request_body = await request.body()
    captured_request_body, request_truncated = capture_body(request_body, proxy.capture_bodies, proxy.max_body_bytes)
    record = TeeRecord(
        request_id=str(uuid.uuid4()),
        started_at=time.time(),
        method=request.method,
        path=f"/v1/{path}",
        query_string=request.url.query,
        model=extract_model(request_body),
        request_body=captured_request_body,
        request_truncated=request_truncated,
    )
    started = time.perf_counter()
    await track_active_request(record)
    upstream_url = proxy_upstream_url(proxy.base_url, path)
    headers = upstream_headers(request, proxy.api_key)
    params = list(request.query_params.multi_items())

    client = httpx.AsyncClient(timeout=httpx.Timeout(60.0, read=None), transport=get_upstream_transport())
    upstream_request = client.build_request(request.method, upstream_url, params=params, headers=headers, content=request_body)
    try:
        upstream_response = await client.send(upstream_request, stream=True)
    except httpx.HTTPError as exc:
        await client.aclose()
        record.latency_ms = (time.perf_counter() - started) * 1000
        record.error = str(exc)
        await update_active_request(record)
        await safe_write_tee_record(proxy.db_path, record)
        await remove_active_request(record.request_id)
        raise HTTPException(status_code=502, detail=f"Upstream request failed: {exc}") from exc

    content_type = upstream_response.headers.get("content-type", "")
    is_streaming = "text/event-stream" in content_type.lower()
    headers_for_client = response_headers(upstream_response.headers)

    if not is_streaming:
        try:
            response_body = await upstream_response.aread()
        finally:
            await upstream_response.aclose()
            await client.aclose()
        captured_response_body, response_truncated = capture_body(response_body, proxy.capture_bodies, proxy.max_body_bytes)
        record.status_code = upstream_response.status_code
        record.latency_ms = (time.perf_counter() - started) * 1000
        record.response_body = captured_response_body
        record.response_truncated = response_truncated
        await update_active_request(record)
        await safe_write_tee_record(proxy.db_path, record)
        await remove_active_request(record.request_id)
        return Response(
            content=response_body,
            status_code=upstream_response.status_code,
            headers=headers_for_client,
            media_type=upstream_response.headers.get("content-type"),
        )

    async def stream_and_capture() -> AsyncIterator[bytes]:
        captured = bytearray()
        response_truncated = False
        error = ""
        try:
            async for chunk in upstream_response.aiter_bytes():
                if proxy.capture_bodies and len(captured) < proxy.max_body_bytes:
                    remaining = proxy.max_body_bytes - len(captured)
                    captured.extend(chunk[:remaining])
                    if len(chunk) > remaining:
                        response_truncated = True
                elif proxy.capture_bodies and chunk:
                    response_truncated = True
                yield chunk
        except Exception as exc:
            error = str(exc)
            raise
        finally:
            record.status_code = upstream_response.status_code
            record.latency_ms = (time.perf_counter() - started) * 1000
            record.error = error
            record.response_body = bytes(captured) if proxy.capture_bodies else None
            record.response_truncated = response_truncated
            await update_active_request(record)
            await upstream_response.aclose()
            await client.aclose()
            await safe_write_tee_record(proxy.db_path, record)
            await remove_active_request(record.request_id)

    return StreamingResponse(
        stream_and_capture(),
        status_code=upstream_response.status_code,
        headers=headers_for_client,
        media_type=upstream_response.headers.get("content-type"),
    )


@app.get("/api/config", response_model=ConfigStatus)
async def config_status(request: Request) -> ConfigStatus:
    config = read_app_config()
    return ConfigStatus(
        app_config=config,
        model=await vllm_model_status(config, str(request.base_url)),
        gpu=gpu_status(),
    )


@app.put("/api/config", response_model=ConfigStatus)
async def update_config(config: AppConfig, request: Request) -> ConfigStatus:
    saved = write_app_config(config)
    return ConfigStatus(
        app_config=saved,
        model=await vllm_model_status(saved, str(request.base_url)),
        gpu=gpu_status(),
    )


@app.post("/api/config/test", response_model=ProxyTestResult)
async def test_proxy_config(payload: ProxyTestRequest) -> ProxyTestResult:
    try:
        models = await detect_proxy_models(payload.base_url, payload.api_key)
    except httpx.HTTPError as exc:
        return ProxyTestResult(ok=False, error=str(exc))
    except ValueError as exc:
        return ProxyTestResult(ok=False, error=str(exc))
    return ProxyTestResult(ok=True, models=models, detail=f"Detected {len(models)} model(s)")


@app.get("/api/requests", response_model=RequestsResponse)
async def request_history(limit: int = 100) -> RequestsResponse:
    config = read_app_config()
    bounded_limit = max(1, min(limit, 500))
    active, saved = await asyncio.gather(
        list_active_request_summaries(),
        asyncio.to_thread(list_saved_tee_records, config.proxy.db_path, bounded_limit),
    )
    return RequestsResponse(active=active, saved=saved)


@app.api_route("/v1/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
async def openai_proxy(path: str, request: Request) -> Response:
    return await proxy_openai_request(path, request)
