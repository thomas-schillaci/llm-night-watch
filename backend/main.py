import base64
import io
import json
import os
import shutil
import subprocess
from pathlib import Path
from typing import Any
from urllib.parse import urljoin

import fitz
import httpx
import jsonschema
from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image
from pydantic import BaseModel


APP_DIR = Path(__file__).resolve().parent
ENV_PATH = APP_DIR / ".env"
load_dotenv(ENV_PATH, override=True)

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


class VllmMetrics(BaseModel):
    num_requests_running: float | None = None
    num_requests_waiting: float | None = None
    available: bool = True
    error: str = ""


class VllmHealth(BaseModel):
    available: bool = True
    error: str = ""


class ToolStatus(BaseModel):
    available: bool = False
    detail: str = ""
    error: str = ""


class ImageStatus(BaseModel):
    image: str = ""
    images: list[str] = []
    pulled: bool = False
    detail: str = ""
    error: str = ""


class GpuStatus(BaseModel):
    detected: bool = False
    devices: list[str] = []
    error: str = ""


class ConfigStatus(BaseModel):
    docker: ToolStatus
    vllm_image: ImageStatus
    gpu: GpuStatus


def openai_settings() -> OpenAISettings:
    load_dotenv(ENV_PATH, override=True)
    return OpenAISettings(
        base_url=os.getenv("OPENAI_BASE_URL", "http://localhost:8001/v1"),
        api_key=os.getenv("OPENAI_API_KEY", "change-me"),
        model=os.getenv("OPENAI_MODEL", "change-me"),
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


def configured_vllm_docker_image() -> str:
    load_dotenv(ENV_PATH, override=True)
    return os.getenv("VLLM_DOCKER_IMAGE", "").strip()


def run_command(command: list[str], timeout: int = 5) -> subprocess.CompletedProcess[str]:
    return subprocess.run(command, capture_output=True, check=False, text=True, timeout=timeout)


def docker_status() -> ToolStatus:
    if shutil.which("docker") is None:
        return ToolStatus(available=False, error="docker command not found")

    try:
        result = run_command(["docker", "--version"])
    except (OSError, subprocess.TimeoutExpired) as exc:
        return ToolStatus(available=False, error=str(exc))

    if result.returncode != 0:
        return ToolStatus(available=False, error=(result.stderr or result.stdout).strip())
    return ToolStatus(available=True, detail=result.stdout.strip())


def local_vllm_images() -> list[str]:
    result = run_command(["docker", "image", "ls", "--format", "{{json .}}"])
    if result.returncode != 0:
        raise RuntimeError((result.stderr or result.stdout).strip())

    images: list[str] = []
    for raw_line in result.stdout.splitlines():
        try:
            image = json.loads(raw_line)
        except json.JSONDecodeError:
            continue

        repository = str(image.get("Repository", "")).strip()
        tag = str(image.get("Tag", "")).strip()
        if not repository or repository == "<none>" or not tag or tag == "<none>":
            continue

        full_name = f"{repository}:{tag}"
        if "vllm" in full_name.lower() and full_name not in images:
            images.append(full_name)
    return sorted(images)


def vllm_image_status(docker: ToolStatus) -> ImageStatus:
    if not docker.available:
        return ImageStatus(pulled=False, error="Docker is not available")

    configured_image = configured_vllm_docker_image()
    try:
        images = local_vllm_images()
    except (OSError, RuntimeError, subprocess.TimeoutExpired) as exc:
        return ImageStatus(image=configured_image, pulled=False, error=str(exc))

    if configured_image:
        if configured_image in images:
            return ImageStatus(image=configured_image, images=images, pulled=True, detail="Configured image is present locally")
        return ImageStatus(
            image=configured_image,
            images=images,
            pulled=False,
            error=f"Configured image was not found locally. Discovered {len(images)} vLLM image{'s' if len(images) != 1 else ''}.",
        )

    if not images:
        return ImageStatus(pulled=False, error="No local Docker images with 'vllm' in the repository or tag were found")
    return ImageStatus(image=images[0], images=images, pulled=True, detail=f"Discovered {len(images)} local vLLM image{'s' if len(images) != 1 else ''}")


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
def settings() -> dict[str, Any]:
    openai = openai_settings()
    return {"openai": {"base_url": openai.base_url, "model": openai.model}}


@app.get("/api/config", response_model=ConfigStatus)
def config_status() -> ConfigStatus:
    docker = docker_status()
    return ConfigStatus(
        docker=docker,
        vllm_image=vllm_image_status(docker),
        gpu=gpu_status(),
    )


@app.get("/api/vllm-metrics", response_model=VllmMetrics)
async def vllm_metrics() -> VllmMetrics:
    settings = openai_settings()
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
async def vllm_health() -> VllmHealth:
    settings = openai_settings()
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
    settings = openai_settings()
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
