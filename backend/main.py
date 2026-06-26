import base64
import io
import json
import shutil
import subprocess
from pathlib import Path
from typing import Any
from urllib.parse import urljoin, urlparse

import fitz
import httpx
import jsonschema
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image
from pydantic import BaseModel, Field


APP_DIR = Path(__file__).resolve().parent
PROJECT_DIR = APP_DIR.parent
CONFIG_PATH = PROJECT_DIR / "llm-night-watch.config.json"
DEFAULT_VLLM_URL = "http://localhost:8000"
DEFAULT_VLLM_MODEL = "auto"
DEFAULT_VLLM_API_KEY = "EMPTY"
DEFAULT_VLLM_IMAGE = "vllm/vllm-openai:latest"

app = FastAPI(title="LLM Night Watch")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class RenderedPrompt(BaseModel):
    text: str


class ProcessedImage(BaseModel):
    dpi: int
    first_n_pages: int
    mime_type: str
    width: int
    height: int
    base64: str
    data_url: str


class ExtractionResult(BaseModel):
    dpi: int
    first_n_pages: int
    prompt: RenderedPrompt
    processed_image: ProcessedImage
    request: dict[str, Any]
    raw_response: dict[str, Any]
    extracted: dict[str, Any]
    status: str = "ok"
    validation_message: str = ""
    validation_errors: list[dict[str, Any]] = []


class OpenAISettings(BaseModel):
    base_url: str
    api_key: str
    model: str


class VllmConfig(BaseModel):
    url: str = DEFAULT_VLLM_URL
    model: str = DEFAULT_VLLM_MODEL
    api_key: str = DEFAULT_VLLM_API_KEY
    image: str = DEFAULT_VLLM_IMAGE


class AppConfig(BaseModel):
    vllm: VllmConfig = Field(default_factory=VllmConfig)


class VllmModelStatus(BaseModel):
    configured: str = DEFAULT_VLLM_MODEL
    resolved: str = ""
    auto_detect: bool = True
    models: list[str] = []
    detail: str = ""
    error: str = ""


class VllmMetrics(BaseModel):
    num_requests_running: float | None = None
    num_requests_waiting: float | None = None
    available: bool = True
    error: str = ""


class VllmHealth(BaseModel):
    available: bool = True
    error: str = ""


class GpuStatus(BaseModel):
    detected: bool = False
    devices: list[str] = []
    error: str = ""


class ConfigStatus(BaseModel):
    app_config: AppConfig
    model: VllmModelStatus
    gpu: GpuStatus


def normalize_vllm_url(url: str) -> str:
    normalized = url.strip().rstrip("/")
    if normalized.endswith("/v1"):
        normalized = normalized[:-3].rstrip("/")
    return normalized or DEFAULT_VLLM_URL


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
    return config


def read_app_config() -> AppConfig:
    if not CONFIG_PATH.exists():
        return AppConfig()

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
    return VllmModelStatus(configured=configured, resolved=models[0], auto_detect=True, models=models, detail=f"Auto-detected {models[0]}")


async def resolve_vllm_model(config: AppConfig, backend_base_url: str | None = None) -> str:
    status = await vllm_model_status(config, backend_base_url)
    if status.resolved:
        return status.resolved
    raise HTTPException(status_code=502, detail=f"Could not auto-detect vLLM model: {status.error or 'unknown error'}")


async def openai_settings(backend_base_url: str | None = None) -> OpenAISettings:
    config = read_app_config()
    return OpenAISettings(
        base_url=vllm_api_base_url(config.vllm.url, backend_base_url),
        api_key=config.vllm.api_key,
        model=await resolve_vllm_model(config, backend_base_url),
    )


def vllm_metrics_url(base_url: str) -> str:
    root = base_url.rstrip("/")
    if root.endswith("/v1"):
        root = root[:-3]
    return urljoin(f"{root}/", "metrics")


def vllm_health_url(base_url: str) -> str:
    root = base_url.rstrip("/")
    if root.endswith("/v1"):
        root = root[:-3]
    return urljoin(f"{root}/", "health")



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


def prometheus_metric_value(metrics_text: str, metric_name: str) -> float | None:
    total = 0.0
    found = False
    prefix = f"{metric_name}"
    for raw_line in metrics_text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or not line.startswith(prefix):
            continue
        parts = line.split()
        if len(parts) < 2:
            continue
        try:
            total += float(parts[1])
        except ValueError:
            continue
        found = True
    return total if found else None


def render_pages_jpeg(pdf_bytes: bytes, dpi: int, first_n_pages: int) -> ProcessedImage:
    try:
        document = fitz.open(stream=pdf_bytes, filetype="pdf")
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Could not read PDF: {exc}") from exc

    if document.page_count < 1:
        raise HTTPException(status_code=400, detail="PDF has no pages")

    page_count = min(first_n_pages, document.page_count)
    rendered_pages: list[Image.Image] = []
    for page_index in range(page_count):
        page = document.load_page(page_index)
        pixmap = page.get_pixmap(dpi=dpi, alpha=False)
        image = Image.open(io.BytesIO(pixmap.tobytes("png")))
        grayscale = image.convert("L")
        rendered_pages.append(grayscale.point(lambda px: 255 if px >= 180 else 0, mode="1").convert("L"))

    combined_width = max(page.width for page in rendered_pages)
    combined_height = sum(page.height for page in rendered_pages)
    combined = Image.new("L", (combined_width, combined_height), 255)
    y_offset = 0
    for page in rendered_pages:
        combined.paste(page, (0, y_offset))
        y_offset += page.height

    output = io.BytesIO()
    combined.save(output, format="JPEG", quality=80, optimize=True)
    encoded = base64.b64encode(output.getvalue()).decode("ascii")
    return ProcessedImage(
        dpi=dpi,
        first_n_pages=page_count,
        mime_type="image/jpeg",
        width=combined.width,
        height=combined.height,
        base64=encoded,
        data_url=f"data:image/jpeg;base64,{encoded}",
    )


def parse_response_format(response_format_text: str) -> dict[str, Any]:
    try:
        parsed = json.loads(response_format_text)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail=f"Response format must be valid JSON: {exc.msg}") from exc

    if not isinstance(parsed, dict):
        raise HTTPException(status_code=400, detail="Response format must be a JSON object")
    return parsed


def build_request(prompt: str, image: ProcessedImage, response_format: dict[str, Any], settings: OpenAISettings) -> dict[str, Any]:
    return {
        "model": settings.model,
        "temperature": 0,
        "max_tokens": 512,
        "response_format": response_format,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {"type": "image_url", "image_url": {"url": image.data_url}},
                ],
            }
        ],
    }


def parse_model_json(raw_response: dict[str, Any]) -> dict[str, Any]:
    try:
        content = raw_response["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as exc:
        raise HTTPException(status_code=502, detail="OpenAI-compatible response did not include message content") from exc

    if isinstance(content, list):
        content = "".join(part.get("text", "") if isinstance(part, dict) else str(part) for part in content)

    try:
        parsed = json.loads(content)
    except json.JSONDecodeError as exc:
        raise HTTPException(
            status_code=502,
            detail={"error": "non_json_model_response", "message": "Model returned non-JSON content", "content": content},
        ) from exc

    if not isinstance(parsed, dict):
        raise HTTPException(
            status_code=502,
            detail={"error": "non_object_model_response", "message": "Model returned JSON, but not a JSON object", "parsed": parsed},
        )

    return parsed


def schema_from_response_format(response_format: dict[str, Any]) -> dict[str, Any] | None:
    if response_format.get("type") != "json_schema":
        return None
    json_schema = response_format.get("json_schema")
    if not isinstance(json_schema, dict):
        return None
    schema = json_schema.get("schema")
    return schema if isinstance(schema, dict) else None


def validation_field(error: jsonschema.ValidationError) -> str:
    if error.path:
        return ".".join(str(part) for part in error.path)
    if error.schema_path and list(error.schema_path)[-1] == "required":
        return "required fields"
    return "response"


def validate_extracted(parsed: dict[str, Any], response_format: dict[str, Any]) -> tuple[dict[str, Any], list[dict[str, Any]], str]:
    schema = schema_from_response_format(response_format)
    if schema is None:
        return parsed, [], ""

    validator = jsonschema.Draft202012Validator(schema)
    errors = sorted(validator.iter_errors(parsed), key=lambda err: list(err.path))
    if not errors:
        return parsed, [], ""

    details = [
        {
            "field": validation_field(error),
            "message": error.message,
            "validator": error.validator,
        }
        for error in errors
    ]
    fields = []
    for detail in details:
        field = detail["field"]
        if field not in fields:
            fields.append(field)

    if len(fields) == 1:
        message = f"Field '{fields[0]}' could not be validated."
    else:
        message = f"Fields {', '.join(repr(field) for field in fields)} could not be validated."
    return parsed, details, message


@app.get("/api/settings")
async def settings(request: Request) -> dict[str, Any]:
    openai = await openai_settings(str(request.base_url))
    return {"openai": {"base_url": openai.base_url, "model": openai.model}}


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


@app.get("/api/vllm-metrics", response_model=VllmMetrics)
async def vllm_metrics(request: Request) -> VllmMetrics:
    settings = await openai_settings(str(request.base_url))
    metrics_url = vllm_metrics_url(settings.base_url)
    try:
        async with httpx.AsyncClient(timeout=3) as client:
            response = await client.get(metrics_url)
            response.raise_for_status()
    except httpx.HTTPError as exc:
        return VllmMetrics(available=False, error=str(exc))

    return VllmMetrics(
        num_requests_running=prometheus_metric_value(response.text, "vllm:num_requests_running"),
        num_requests_waiting=prometheus_metric_value(response.text, "vllm:num_requests_waiting"),
    )


@app.get("/api/vllm", response_model=VllmHealth)
async def vllm_health(request: Request) -> VllmHealth:
    settings = await openai_settings(str(request.base_url))
    health_url = vllm_health_url(settings.base_url)
    try:
        async with httpx.AsyncClient(timeout=3) as client:
            response = await client.get(health_url)
            response.raise_for_status()
    except httpx.HTTPError as exc:
        return VllmHealth(available=False, error=str(exc))

    return VllmHealth()


@app.post("/api/extract", response_model=ExtractionResult)
async def extract(
    request: Request,
    file: UploadFile = File(...),
    dpi: int = Form(100),
    first_n_pages: int = Form(1),
    prompt: str = Form(...),
    response_format: str = Form(...),
) -> ExtractionResult:
    if dpi < 50 or dpi > 400:
        raise HTTPException(status_code=400, detail="dpi must be between 50 and 400")
    if first_n_pages < 1 or first_n_pages > 10:
        raise HTTPException(status_code=400, detail="first_n_pages must be between 1 and 10")
    if file.content_type not in {"application/pdf", "application/octet-stream"}:
        raise HTTPException(status_code=400, detail="Upload a PDF")
    if not prompt.strip():
        raise HTTPException(status_code=400, detail="Prompt cannot be empty")

    parsed_response_format = parse_response_format(response_format)
    pdf_bytes = await file.read()
    rendered_prompt = RenderedPrompt(text=prompt)
    image = render_pages_jpeg(pdf_bytes, dpi, first_n_pages)
    settings = await openai_settings(str(request.base_url))
    request_body = build_request(rendered_prompt.text, image, parsed_response_format, settings)

    try:
        async with httpx.AsyncClient(base_url=settings.base_url, timeout=120) as client:
            response = await client.post(
                "/chat/completions",
                headers={"Authorization": f"Bearer {settings.api_key}"},
                json=request_body,
            )
            response.raise_for_status()
    except httpx.HTTPStatusError as exc:
        raise HTTPException(status_code=502, detail=f"OpenAI-compatible endpoint returned {exc.response.status_code}: {exc.response.text}") from exc
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"OpenAI-compatible endpoint failed: {exc}") from exc

    raw = response.json()
    parsed = parse_model_json(raw)
    extracted, validation_errors, message = validate_extracted(parsed, parsed_response_format)
    return ExtractionResult(
        dpi=dpi,
        first_n_pages=image.first_n_pages,
        prompt=rendered_prompt,
        processed_image=image,
        request=request_body,
        raw_response=raw,
        extracted=extracted,
        status="validation_failed" if validation_errors else "ok",
        validation_message=message,
        validation_errors=validation_errors,
    )
