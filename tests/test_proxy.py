import json
import sqlite3
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from backend import main


@pytest.fixture(autouse=True)
def clear_active_requests():
    main.active_requests.clear()
    yield
    main.active_requests.clear()


def write_config(path: Path, db_path: Path, max_body_bytes: int = 1_000_000) -> None:
    path.write_text(
        json.dumps(
            {
                "vllm": {
                    "url": "http://upstream",
                    "model": "auto",
                    "api_key": "configured-key",
                    "image": "vllm/vllm-openai:latest",
                },
                "proxy": {
                    "base_url": "http://upstream",
                    "api_key": "configured-key",
                    "capture_bodies": True,
                    "max_body_bytes": max_body_bytes,
                    "db_path": str(db_path),
                },
            }
        ),
        encoding="utf-8",
    )


def records(db_path: Path) -> list[sqlite3.Row]:
    with sqlite3.connect(db_path) as connection:
        connection.row_factory = sqlite3.Row
        return list(connection.execute("SELECT * FROM openai_request_tee ORDER BY id"))


def test_config_test_endpoint_reports_models(monkeypatch, tmp_path):
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url == "http://upstream/v1/models"
        assert request.headers["authorization"] == "Bearer test-key"
        return httpx.Response(200, json={"data": [{"id": "model-a"}, {"id": "model-b"}]})

    monkeypatch.setattr(main, "CONFIG_PATH", tmp_path / "config.json")
    main.app.state.upstream_transport = httpx.MockTransport(handler)

    with TestClient(main.app) as client:
        response = client.post("/api/config/test", json={"base_url": "http://upstream", "api_key": "test-key"})

    assert response.status_code == 200
    assert response.json() == {"ok": True, "models": ["model-a", "model-b"], "detail": "Detected 2 model(s)", "error": ""}


def test_upstream_status_reports_connected(monkeypatch, tmp_path):
    config_path = tmp_path / "config.json"
    db_path = tmp_path / "tee.sqlite3"
    write_config(config_path, db_path)

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url == "http://upstream/v1/models"
        return httpx.Response(200, json={"data": [{"id": "model-a"}]})

    monkeypatch.setattr(main, "CONFIG_PATH", config_path)
    main.app.state.upstream_transport = httpx.MockTransport(handler)

    with TestClient(main.app) as client:
        response = client.get("/api/status")

    assert response.status_code == 200
    assert response.json() == {"connected": True, "detail": "Detected 1 model(s)", "error": ""}


def test_upstream_status_reports_disconnected(monkeypatch, tmp_path):
    config_path = tmp_path / "config.json"
    db_path = tmp_path / "tee.sqlite3"
    write_config(config_path, db_path)

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused", request=request)

    monkeypatch.setattr(main, "CONFIG_PATH", config_path)
    main.app.state.upstream_transport = httpx.MockTransport(handler)

    with TestClient(main.app) as client:
        response = client.get("/api/status")

    assert response.status_code == 200
    payload = response.json()
    assert payload["connected"] is False
    assert "connection refused" in payload["error"]


def test_non_streaming_proxy_forwards_and_captures(monkeypatch, tmp_path):
    config_path = tmp_path / "config.json"
    db_path = tmp_path / "tee.sqlite3"
    write_config(config_path, db_path)

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.method == "POST"
        assert request.url == "http://upstream/v1/chat/completions?trace=1"
        assert request.headers["authorization"] == "Bearer caller-key"
        assert json.loads(request.content) == {"model": "night-model", "messages": [{"role": "user", "content": "hi"}]}
        return httpx.Response(200, json={"id": "chatcmpl_1", "choices": []})

    monkeypatch.setattr(main, "CONFIG_PATH", config_path)
    main.app.state.upstream_transport = httpx.MockTransport(handler)

    with TestClient(main.app) as client:
        response = client.post(
            "/v1/chat/completions?trace=1",
            headers={"Authorization": "Bearer caller-key"},
            json={"model": "night-model", "messages": [{"role": "user", "content": "hi"}]},
        )

    assert response.status_code == 200
    assert response.json() == {"id": "chatcmpl_1", "choices": []}

    [record] = records(db_path)
    assert record["method"] == "POST"
    assert record["path"] == "/v1/chat/completions"
    assert record["query_string"] == "trace=1"
    assert record["model"] == "night-model"
    assert record["status_code"] == 200
    assert b"caller-key" not in record["request_body"]
    assert json.loads(record["request_body"]) ["model"] == "night-model"
    assert json.loads(record["response_body"]) == {"id": "chatcmpl_1", "choices": []}


def test_streaming_proxy_captures_after_stream(monkeypatch, tmp_path):
    config_path = tmp_path / "config.json"
    db_path = tmp_path / "tee.sqlite3"
    write_config(config_path, db_path)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            headers={"content-type": "text/event-stream"},
            content=b"data: first\n\ndata: second\n\n",
        )

    monkeypatch.setattr(main, "CONFIG_PATH", config_path)
    main.app.state.upstream_transport = httpx.MockTransport(handler)

    with TestClient(main.app) as client:
        with client.stream("POST", "/v1/chat/completions", json={"model": "stream-model", "stream": True}) as response:
            body = b"".join(response.iter_bytes())

    assert response.status_code == 200
    assert body == b"data: first\n\ndata: second\n\n"
    [record] = records(db_path)
    assert record["model"] == "stream-model"
    assert record["response_body"] == body


def test_capture_truncates_large_bodies(monkeypatch, tmp_path):
    config_path = tmp_path / "config.json"
    db_path = tmp_path / "tee.sqlite3"
    write_config(config_path, db_path, max_body_bytes=8)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=b"response-too-long")

    monkeypatch.setattr(main, "CONFIG_PATH", config_path)
    main.app.state.upstream_transport = httpx.MockTransport(handler)

    with TestClient(main.app) as client:
        response = client.post("/v1/completions", content=b"request-too-long")

    assert response.status_code == 200
    [record] = records(db_path)
    assert record["request_body"] == b"request-"
    assert record["response_body"] == b"response"
    assert record["request_truncated"] == 1
    assert record["response_truncated"] == 1


def test_upstream_error_is_preserved_and_captured(monkeypatch, tmp_path):
    config_path = tmp_path / "config.json"
    db_path = tmp_path / "tee.sqlite3"
    write_config(config_path, db_path)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(429, json={"error": {"message": "rate limited"}})

    monkeypatch.setattr(main, "CONFIG_PATH", config_path)
    main.app.state.upstream_transport = httpx.MockTransport(handler)

    with TestClient(main.app) as client:
        response = client.post("/v1/chat/completions", json={"model": "busy"})

    assert response.status_code == 429
    assert response.json() == {"error": {"message": "rate limited"}}
    [record] = records(db_path)
    assert record["status_code"] == 429
    assert json.loads(record["response_body"]) == {"error": {"message": "rate limited"}}


def test_tee_write_failure_does_not_fail_proxy(monkeypatch, tmp_path):
    config_path = tmp_path / "config.json"
    db_path = tmp_path / "missing" / "tee.sqlite3"
    write_config(config_path, db_path)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"ok": True})

    def broken_write(db_path: str, record: main.TeeRecord) -> None:
        raise OSError("disk full")

    monkeypatch.setattr(main, "CONFIG_PATH", config_path)
    monkeypatch.setattr(main, "write_tee_record", broken_write)
    main.app.state.upstream_transport = httpx.MockTransport(handler)

    with TestClient(main.app) as client:
        response = client.get("/v1/models")

    assert response.status_code == 200
    assert response.json() == {"ok": True}



def test_chat_completions_response_is_flagged_when_schema_mismatches(monkeypatch, tmp_path):
    config_path = tmp_path / "config.json"
    db_path = tmp_path / "tee.sqlite3"
    config_path.write_text(
        json.dumps(
            {
                "vllm": {
                    "url": "http://upstream",
                    "model": "auto",
                    "api_key": "configured-key",
                    "image": "vllm/vllm-openai:latest",
                },
                "proxy": {
                    "base_url": "http://upstream",
                    "api_key": "configured-key",
                    "capture_bodies": True,
                    "max_body_bytes": 1_000_000,
                    "db_path": str(db_path),
                },
                "validation": {"fields": [{"name": "id", "type": "string"}, {"name": "choices", "type": "array"}]},
            }
        ),
        encoding="utf-8",
    )

    message_content = json.dumps({"id": 123, "choices": "not-an-array"})

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={"choices": [{"message": {"content": message_content}}]},
        )

    monkeypatch.setattr(main, "CONFIG_PATH", config_path)
    main.app.state.upstream_transport = httpx.MockTransport(handler)

    with TestClient(main.app) as client:
        response = client.post("/v1/chat/completions", json={"model": "night-model"})

    assert response.status_code == 200

    [record] = records(db_path)
    issues = json.loads(record["validation_issues"])
    assert "Field 'id' expected type 'string'" in issues
    assert "Field 'choices' expected type 'array'" in issues


def test_chat_completions_response_matching_schema_has_no_issues(monkeypatch, tmp_path):
    config_path = tmp_path / "config.json"
    db_path = tmp_path / "tee.sqlite3"
    config_path.write_text(
        json.dumps(
            {
                "vllm": {
                    "url": "http://upstream",
                    "model": "auto",
                    "api_key": "configured-key",
                    "image": "vllm/vllm-openai:latest",
                },
                "proxy": {
                    "base_url": "http://upstream",
                    "api_key": "configured-key",
                    "capture_bodies": True,
                    "max_body_bytes": 1_000_000,
                    "db_path": str(db_path),
                },
                "validation": {"fields": [{"name": "id", "type": "string"}]},
            }
        ),
        encoding="utf-8",
    )

    message_content = json.dumps({"id": "chatcmpl_1"})

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={"choices": [{"message": {"content": message_content}}]},
        )

    monkeypatch.setattr(main, "CONFIG_PATH", config_path)
    main.app.state.upstream_transport = httpx.MockTransport(handler)

    with TestClient(main.app) as client:
        response = client.post("/v1/chat/completions", json={"model": "night-model"})

    assert response.status_code == 200
    [record] = records(db_path)
    assert json.loads(record["validation_issues"]) == []


def test_request_history_lists_active_and_saved(monkeypatch, tmp_path):
    config_path = tmp_path / "config.json"
    db_path = tmp_path / "tee.sqlite3"
    write_config(config_path, db_path)
    monkeypatch.setattr(main, "CONFIG_PATH", config_path)

    active = main.TeeRecord(
        request_id="active-1",
        started_at=1_700_000_000,
        method="POST",
        path="/v1/chat/completions",
        query_string="",
        model="active-model",
        request_body=b'{"model":"active-model"}',
    )
    main.active_requests[active.request_id] = active

    saved = main.TeeRecord(
        request_id="saved-1",
        started_at=1_700_000_001,
        method="POST",
        path="/v1/completions",
        query_string="trace=1",
        model="saved-model",
        status_code=200,
        latency_ms=12.5,
        request_body=b'{"model":"saved-model"}',
        response_body=b'{"ok":true}',
    )
    main.write_tee_record(str(db_path), saved)

    with TestClient(main.app) as client:
        response = client.get("/api/requests?limit=25")

    assert response.status_code == 200
    payload = response.json()
    assert len(payload["active"]) == 1
    assert payload["active"][0]["request_id"] == "active-1"
    assert payload["active"][0]["running"] is True
    assert payload["active"][0]["request_body"] == '{"model":"active-model"}'
    assert len(payload["saved"]) == 1
    assert payload["saved"][0]["request_id"] == "saved-1"
    assert payload["saved"][0]["running"] is False
    assert payload["saved"][0]["response_body"] == '{"ok":true}'
