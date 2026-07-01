import json
import shutil
import subprocess
from pathlib import Path
from urllib.parse import urljoin, urlparse

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
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
