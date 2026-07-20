#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Shared model-routing helpers for PiNovelStudio scripts."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any


BASE_URL_ENV_MAP = {
    "glm": "GLM_BASE_URL",
    "doubao": "ARK_BASE_URL",
    "deepseek": "DEEPSEEK_BASE_URL",
    "qwen": "QWEN_BASE_URL",
    "claude": "CLAUDE_BASE_URL",
    "gpt": "GPT_BASE_URL",
}

MODEL_OVERRIDE_ENV_MAP = {
    "glm": ["GLM_MODEL"],
    "doubao": ["DOUBAO_MODEL", "ARK_MODEL"],
    "qwen": ["QWEN_MODEL"],
    "claude": ["CLAUDE_MODEL"],
    "gpt": ["GPT_MODEL"],
    "deepseek": ["DEEPSEEK_MODEL"],
}


def load_dotenv(path: Path) -> None:
    """Load simple KEY=VALUE pairs without printing or overwriting secrets."""
    if not path.exists():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def normalize_base_url(base_url: str) -> str:
    return base_url.rstrip("/")


def load_model_routing(repo_root: Path) -> dict[str, Any]:
    path = repo_root / "config" / "model-routing.json"
    return json.loads(path.read_text(encoding="utf-8"))


def provider_base_url_env(provider_key: str) -> str:
    return BASE_URL_ENV_MAP.get(provider_key, f"{provider_key.upper()}_BASE_URL")


def provider_model_env_keys(provider_key: str, default_model: str) -> list[str]:
    if provider_key != "deepseek":
        return MODEL_OVERRIDE_ENV_MAP.get(provider_key, [f"{provider_key.upper()}_MODEL"])

    lower_default = default_model.lower()
    if "flash" in lower_default:
        return ["DEEPSEEK_MODEL_FLASH", "DEEPSEEK_MODEL"]
    if "pro" in lower_default:
        return ["DEEPSEEK_MODEL_PRO", "DEEPSEEK_MODEL"]
    return MODEL_OVERRIDE_ENV_MAP["deepseek"]


def provider_api_key(provider_key: str, api_key_env: str) -> str:
    value = os.environ.get(api_key_env, "")
    if value:
        return value
    if provider_key == "glm":
        return os.environ.get("ZHIPU_API_KEY", "")
    if provider_key == "doubao":
        return os.environ.get("ARK_API_KEY", "") or os.environ.get("DOUBAO_API_KEY", "")
    return ""


def provider_model(provider_key: str, default_model: str) -> str:
    for env_key in provider_model_env_keys(provider_key, default_model):
        value = os.environ.get(env_key, "")
        if value:
            return value
    return default_model


def resolve_provider_configs(
    repo_root: Path,
    selected_ids: list[str] | None = None,
) -> dict[str, dict[str, Any]]:
    routing = load_model_routing(repo_root)
    selected = set(selected_ids or [])
    models: dict[str, dict[str, Any]] = {}

    for provider_key, provider_cfg in routing.get("providers", {}).items():
        if selected and provider_key not in selected:
            continue
        if not isinstance(provider_cfg, dict):
            continue

        default_model = str(provider_cfg.get("model") or "")
        nested_models = provider_cfg.get("models")
        if not default_model and isinstance(nested_models, dict) and nested_models:
            first_key = next(iter(nested_models))
            first_model = nested_models[first_key]
            if isinstance(first_model, dict):
                default_model = str(first_model.get("id") or first_key)
            else:
                default_model = str(first_key)

        api_key_env = str(provider_cfg.get("api_key_env") or f"{provider_key.upper()}_API_KEY")
        api_key = provider_api_key(provider_key, api_key_env)
        if not api_key or not default_model:
            continue

        base_url_env = provider_base_url_env(provider_key)
        default_base_url = str(provider_cfg.get("base_url") or "")
        models[provider_key] = {
            "id": provider_key,
            "display_name": str(provider_cfg.get("name") or provider_key),
            "protocol": str(provider_cfg.get("protocol") or "openai"),
            "base_url": normalize_base_url(os.environ.get(base_url_env, default_base_url)),
            "model": provider_model(provider_key, default_model),
            "api_key_env": api_key_env,
            "model_envs": provider_model_env_keys(provider_key, default_model),
            "base_url_env": base_url_env,
            "api_key": api_key,
            "request_options": provider_cfg.get("request_options") or {},
        }

    return models

