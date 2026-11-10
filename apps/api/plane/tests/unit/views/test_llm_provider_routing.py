# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Each LLM provider's key goes to that provider's own host, through the real OpenAI client."""

import json
from unittest import mock

import httpx
import pytest

from plane.app.views.external.base import get_llm_response

API_KEY = "provider-key"
COMPLETION = {
    "id": "completion",
    "object": "chat.completion",
    "created": 0,
    "model": "any",
    "choices": [{"index": 0, "finish_reason": "stop", "message": {"role": "assistant", "content": "done"}}],
}


@pytest.fixture
def sent_requests():
    requests = []

    def send(request, **_kwargs):
        requests.append(request)
        return httpx.Response(200, json=COMPLETION, request=request)

    with mock.patch("httpx.Client.send", side_effect=send):
        yield requests


@pytest.mark.unit
class TestLLMProviderRouting:
    @pytest.mark.parametrize(
        "provider, model, host, path",
        [
            ("openai", "gpt-4o-mini", "api.openai.com", "/v1/chat/completions"),
            ("anthropic", "claude-3-haiku-20240307", "api.anthropic.com", "/v1/chat/completions"),
            ("Anthropic", "claude-3-haiku-20240307", "api.anthropic.com", "/v1/chat/completions"),
            (
                "gemini",
                "gemini-1.5-pro-latest",
                "generativelanguage.googleapis.com",
                "/v1beta/openai/chat/completions",
            ),
        ],
    )
    def test_key_and_model_reach_the_selected_provider(self, sent_requests, provider, model, host, path):
        text, error = get_llm_response("task", "prompt", API_KEY, model, provider)

        assert (text, error) == ("done", None)
        assert len(sent_requests) == 1
        request = sent_requests[0]
        assert request.url.host == host
        assert request.url.path == path
        assert request.headers["authorization"] == f"Bearer {API_KEY}"
        assert json.loads(request.content)["model"] == model

    @pytest.mark.parametrize("provider", ["anthropic", "gemini"])
    def test_openai_base_url_override_does_not_redirect_other_providers(self, sent_requests, monkeypatch, provider):
        monkeypatch.setenv("OPENAI_BASE_URL", "https://openai-proxy.example.com/v1")

        get_llm_response("task", "prompt", API_KEY, "model", provider)

        assert sent_requests[0].url.host != "openai-proxy.example.com"

    def test_unknown_provider_sends_nothing(self, sent_requests):
        text, error = get_llm_response("task", "prompt", API_KEY, "model", "unknown")

        assert text is None
        assert error
        assert sent_requests == []
