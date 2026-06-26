import base64
import io
import json
import os
from pathlib import Path
from typing import Any

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
    mime_type: str
    width: int
    height: int
    base64: str
    data_url: str


class ExtractionResult(BaseModel):
    dpi: int
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


def openai_settings() -> OpenAISettings:
    load_dotenv(ENV_PATH, override=True)
    return OpenAISettings(
        base_url=os.getenv("OPENAI_BASE_URL", "http://localhost:8001/v1"),
        api_key=os.getenv("OPENAI_API_KEY", "change-me"),
        model=os.getenv("OPENAI_MODEL", "change-me"),
    )


def render_first_page_jpeg(pdf_bytes: bytes, dpi: int) -> ProcessedImage:
    try:
        document = fitz.open(stream=pdf_bytes, filetype="pdf")
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Could not read PDF: {exc}") from exc

    if document.page_count < 1:
        raise HTTPException(status_code=400, detail="PDF has no pages")

    page = document.load_page(0)
    pixmap = page.get_pixmap(dpi=dpi, alpha=False)
    image = Image.open(io.BytesIO(pixmap.tobytes("png")))
    grayscale = image.convert("L")
    thresholded = grayscale.point(lambda px: 255 if px >= 180 else 0, mode="1").convert("L")

    output = io.BytesIO()
    thresholded.save(output, format="JPEG", quality=80, optimize=True)
    encoded = base64.b64encode(output.getvalue()).decode("ascii")
    return ProcessedImage(
        dpi=dpi,
        mime_type="image/jpeg",
        width=thresholded.width,
        height=thresholded.height,
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


@app.post("/api/extract", response_model=ExtractionResult)
async def extract(
    file: UploadFile = File(...),
    dpi: int = Form(100),
    prompt: str = Form(...),
    response_format: str = Form(...),
) -> ExtractionResult:
    if dpi not in (100, 200):
        raise HTTPException(status_code=400, detail="dpi must be 100 or 200")
    if file.content_type not in {"application/pdf", "application/octet-stream"}:
        raise HTTPException(status_code=400, detail="Upload a PDF")
    if not prompt.strip():
        raise HTTPException(status_code=400, detail="Prompt cannot be empty")

    parsed_response_format = parse_response_format(response_format)
    pdf_bytes = await file.read()
    rendered_prompt = RenderedPrompt(text=prompt)
    image = render_first_page_jpeg(pdf_bytes, dpi)
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
        prompt=rendered_prompt,
        processed_image=image,
        request=request_body,
        raw_response=raw,
        extracted=extracted,
        status="validation_failed" if validation_errors else "ok",
        validation_message=message,
        validation_errors=validation_errors,
    )
