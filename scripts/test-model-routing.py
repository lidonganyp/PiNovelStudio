#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""PiNovelStudio - LLM Routing Benchmark

Tests 6 agent roles x 5 models = 30 API calls.
Evaluates which model fits each role best.

NOTE: All API keys must be set via environment variables.
Required env vars: ZHIPU_API_KEY (or GLM_API_KEY), DEEPSEEK_API_KEY, QWEN_API_KEY,
                   CLAUDE_API_KEY, GPT_API_KEY
"""
import json
import subprocess
import sys
import argparse
from pathlib import Path
from typing import Any

from model_routing_config import load_dotenv, load_model_routing, resolve_provider_configs


# ── Configuration ────────────────────────────────────────────
# API keys MUST be read from environment variables (never hardcode)

REPO_ROOT = Path(__file__).resolve().parents[1]


def configure_stdout() -> None:
    """Use UTF-8 output so Windows terminals do not break on result text."""
    try:
        sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)
        sys.stderr.reconfigure(encoding="utf-8", line_buffering=True)
    except AttributeError:
        pass


def build_config() -> dict[str, dict[str, Any]]:
    """Build provider config from config/model-routing.json and .env."""
    configs = resolve_provider_configs(REPO_ROOT)
    if not configs:
        print("FATAL: No configured models found. Check .env and config/model-routing.json.", file=sys.stderr)
        sys.exit(1)
    return configs


def current_provider_for_role(role: str) -> str:
    """Read current agent routing from the central model routing config."""
    route = ROUTE_CONFIG.get("agent_routing", {}).get(role)
    if isinstance(route, dict):
        return str(route.get("provider") or "unknown")
    if isinstance(route, str):
        return route
    return "unknown"


CONFIG: dict[str, dict[str, Any]] = {}
PROVIDERS = []
ROUTE_CONFIG: dict[str, Any] = {}


# ── Test Cases ──────────────────────────────────────────────
TEST_CASES = [
    (
        "narrator_primary",
        "You are a novelist. Use vivid sensory details. Show, don't tell.",
        "Write a 150-word scene: rainy night, protagonist enters an ancient mysterious library for the first time. Focus on atmosphere and sensory details.",
        500,
    ),
    (
        "critic",
        "You are a senior literary editor. Critique: writing quality, emotional tension, descriptive technique.",
        "Critique this passage: 'He walked into the room. It was dark. He turned on the light and saw a letter on the desk. He read it. It was shocking. He sat and stared.' Give specific, actionable feedback.",
        500,
    ),
    (
        "anti_ai_detector",
        "Detect AI-writing patterns: redundant modifiers, perfect sentences, templated emotions, transitional crutches, over-explanation. Be specific with examples from the text.",
        "Detect AI patterns in: 'The gentle breeze carried the fragrance of flowers. She breathed deeply, feeling nature's beauty. Time seemed to stand still. All her worries vanished. Her heart was filled with gratitude. She knew she had the courage to face anything.' List each issue found.",
        500,
    ),
    (
        "character_agent",
        "Design deep, three-dimensional characters. Include contradictions, hidden wounds, and growth potential.",
        "Create a character: Lu Chen, 35, former special forces sniper, now runs a small old bookstore. 150 words covering core traits, inner conflicts, and hidden depths.",
        500,
    ),
    (
        "style_shaper",
        "You are a style transformation expert. Transform plain text into vivid literary prose. Use fresh metaphors and strong imagery.",
        "Rewrite this vividly: 'He was angry because his girlfriend was an hour late. They met at a coffee shop. He waited impatiently. She said there was traffic. He didn't believe her.'",
        500,
    ),
    (
        "dependency_checker",
        "You are a plot logic validator. Check causal consistency. List all logical contradictions clearly.",
        "Check this: Earlier (Chapter 3): Li Ming broke his right leg, hospitalized with a cast, doctor ordered no weight-bearing for 6 weeks. Chapter 5: 'Li Ming jumped from the hospital window, landed steadily on his feet, and sprinted toward the street corner.' Is this logical? Explain.",
        300,
    ),
]


# ── API Call ───────────────────────────────────────────────
def call_llm(provider, system_prompt, user_prompt, max_tokens):
    cfg = CONFIG[provider]
    is_claude = cfg.get("protocol") == "anthropic"
    is_gpt = provider == "gpt"

    if is_claude:
        body = {
            "model": cfg["model"],
            "messages": [{"role": "user", "content": user_prompt}],
            "system": system_prompt,
            "max_tokens": max_tokens,
            "temperature": 0.3,
        }
        url = cfg["base_url"] + "/messages"
        headers = [
            "-H", "Content-Type: application/json",
            "-H", "x-api-key: " + cfg["api_key"],
            "-H", "anthropic-version: 2023-06-01",
        ]
    else:
        body = {
            "model": cfg["model"],
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            "max_tokens": max_tokens,
            "temperature": 0.3,
        }
        request_options = cfg.get("request_options", {})
        if isinstance(request_options, dict):
            for key, value in request_options.items():
                body[key] = value
        url = cfg["base_url"] + "/chat/completions"
        headers = [
            "-H", "Content-Type: application/json",
            "-H", "Authorization: Bearer " + cfg["api_key"],
        ]

    cmd = ["curl", "-s", "-m", "35", "-w", "\n%{http_code}"]
    if is_gpt:
        cmd.append("--ssl-no-revoke")
    cmd.extend(["-X", "POST", url])
    cmd.extend(headers)
    cmd.extend(["-d", json.dumps(body, ensure_ascii=False)])

    try:
        result = subprocess.run(cmd, capture_output=True, timeout=45)
        out = result.stdout.decode("utf-8", errors="replace")
        if result.returncode != 0:
            err = result.stderr.decode("utf-8", errors="replace")[:80]
            return None, f"CURL_EXIT:{result.returncode} {err}"

        lines = out.strip().split("\n")
        code = lines[-1].strip()
        body_text = "\n".join(lines[:-1])

        if code != "200":
            return None, f"HTTP {code}: {body_text[:150]}"

        data = json.loads(body_text)
        if is_claude:
            content_blocks = data.get("content", [])
            content = content_blocks[0].get("text", "") if content_blocks else ""
        else:
            choices = data.get("choices", [])
            content = choices[0].get("message", {}).get("content", "") if choices else ""

        return content, None

    except subprocess.TimeoutExpired:
        return None, "TIMEOUT"
    except Exception as e:
        return None, str(e)[:80]


# ── Scoring ─────────────────────────────────────────────────
def score_response(role, text):
    """Return dict of dimension->score (1-5). avail=0 means unavailable."""
    scores = {}
    if len(text) < 10:
        scores["avail"] = 0
        return scores
    scores["avail"] = 5

    t = text.lower()
    wc = len(text)

    # Length quality
    scores["length"] = min(5, max(1, wc // 60)) if wc > 30 else 1

    if role == "narrator_primary":
        sensory_words = ["dark", "light", "shadow", "dust", "old", "silent",
                         "smell", "cold", "damp", "flicker", "dim", "echo"]
        senses = sum(1 for w in sensory_words if w in t)
        scores["sensory"] = min(5, senses)
        tell_words = ["felt", "seemed", "appeared", "looked", "sensed",
                       "realized", "knew", "wondered"]
        tell_count = sum(1 for w in tell_words if w in t)
        scores["show"] = max(1, 5 - tell_count)

    elif role == "critic":
        depth_words = ["issue", "lack", "weak", "flat", "tell", "improve",
                       "specific", "concrete", "instead", "could", "suggest",
                       "detail", "depth", "emotion", "passive"]
        scores["depth"] = min(5, sum(1 for w in depth_words if w in t))

    elif role == "anti_ai_detector":
        pattern_words = ["redundant", "template", "cliche", "vague",
                         "abstract", "perfect", "generic", "formulaic",
                         "overly", "artificial", "stiff"]
        scores["precision"] = min(5, sum(1 for w in pattern_words if w in t))
        if '"' in t or "'" in t or "line" in t or "sentence" in t or "example" in t:
            scores["specific"] = 5
        else:
            scores["specific"] = 2

    elif role == "character_agent":
        depth_words = ["conflict", "trauma", "past", "inner", "fear",
                       "desire", "secret", "wound", "guilt", "regret",
                       "alone", "silent", "control", "precision"]
        scores["depth"] = min(5, sum(1 for w in depth_words if w in t))
        unique_words = ["sniper", "book", "store", "gun", "veteran",
                        "military", "scope", "trigger", "page", "read"]
        scores["unique"] = min(5, sum(1 for w in unique_words if w in t))

    elif role == "style_shaper":
        imagery_words = ["rain", "shadow", "light", "cold", "night",
                         "window", "coffee", "smoke", "gray", "drip",
                         "frost", "bitter", "clock", "minute", "pane"]
        scores["imagery"] = min(5, sum(1 for w in imagery_words if w in t))
        original_phrases = ["angry", "late", "hour", "wait", "traffic", "believe"]
        similarity = sum(1 for p in original_phrases if p in t)
        scores["originality"] = max(1, 5 - similarity)

    elif role == "dependency_checker":
        logic_words = ["contradict", "logic", "inconsist", "error",
                       "impossible", "cannot", "violate", "ignore",
                       "broken", "fracture", "jump", "weight", "cast"]
        scores["logic"] = min(5, sum(1 for w in logic_words if w in t))

    return scores


# ── Main ───────────────────────────────────────────────────
def parse_args():
    parser = argparse.ArgumentParser(description="Test PiNovelStudio model routing connectivity and role fit.")
    parser.add_argument(
        "--env-file",
        default=str(REPO_ROOT / ".env"),
        help="Path to a .env file. Defaults to the repository .env.",
    )
    return parser.parse_args()


def main():
    global CONFIG, PROVIDERS, ROUTE_CONFIG
    configure_stdout()
    args = parse_args()
    load_dotenv(Path(args.env_file))
    ROUTE_CONFIG = load_model_routing(REPO_ROOT)
    CONFIG = build_config()
    PROVIDERS = list(CONFIG.keys())

    print("=" * 70)
    print("  PiNovelStudio - LLM Routing Benchmark")
    print("  6 agent roles x 5 models = 30 API calls")
    print("=" * 70)

    all_results = {}

    for role, sys_p, usr_p, max_tok in TEST_CASES:
        current = current_provider_for_role(role)
        print(f"\n{'='*60}")
        print(f"  [{role}]  current routing: {current}")
        print(f"  sys: {sys_p[:60]}...")
        print(f"  usr: {usr_p[:60]}...")
        print(f"{'='*60}")

        role_results = {}

        for prov in PROVIDERS:
            sys.stdout.write(f"    {prov:10s} ... ")
            sys.stdout.flush()

            content, err = call_llm(prov, sys_p, usr_p, max_tok)

            if err:
                print(f"FAIL: {err}")
                role_results[prov] = {"text": f"[ERR] {err}", "scores": {"avail": 0}}
            else:
                scores = score_response(role, content)
                avg = sum(scores.values()) / max(len(scores), 1) if scores.get("avail", 0) > 0 else 0
                print(f"OK  avg={avg:.1f}")
                for k, v in scores.items():
                    if k != "avail":
                        bar = "".join(["@" if i < v else "." for i in range(5)])
                        print(f"      {k:12s} {bar} ({v}/5)")
                print(f"      preview: {content[:100]}...")
                role_results[prov] = {"text": content, "scores": scores}

        all_results[role] = role_results

    # ── Summary ──
    print("\n\n" + "=" * 70)
    print("  ROUTING VERDICT")
    print("  " + "=" * 70)

    for role, _, _, _ in TEST_CASES:
        current = current_provider_for_role(role)
        rr = all_results[role]
        valid = {p: r for p, r in rr.items() if r["scores"].get("avail", 0) > 0}
        if not valid:
            print(f"\n  [{role}] NO VALID RESULTS")
            continue

        ranked = sorted(
            valid.items(),
            key=lambda x: -sum(x[1]["scores"].values()) / max(len(x[1]["scores"]), 1),
        )

        best = ranked[0][0]
        match = best == current
        verdict = "MATCH - optimal" if match else f"MISMATCH - switch to {best}"

        print(f"\n  [{role}]")
        print(f"    Current: {current}")
        print(f"    Best:    {best}")
        print(f"    Verdict: {verdict}")

        for i, (prov, data) in enumerate(ranked, 1):
            avg = sum(data["scores"].values()) / max(len(data["scores"]), 1)
            marker = ""
            if prov == current:
                marker = " << CURRENT"
            elif prov == best:
                marker = " << BEST"
            print(f"    {i}. {prov:10s}  {avg:.1f}{marker}")
            for k, v in data["scores"].items():
                if k != "avail":
                    print(f"       {k}: {v}")

    # ── Full Responses ──
    print("\n\n" + "=" * 70)
    print("  FULL RESPONSES")
    print("=" * 70)
    for role, _, _, _ in TEST_CASES:
        rr = all_results[role]
        for prov in PROVIDERS:
            print(f"\n{'─'*50}")
            print(f"  [{role}] <- [{prov}]")
            print(f"{'─'*50}")
            data = rr.get(prov, {})
            if data.get("scores", {}).get("avail", 0) > 0:
                print(data.get("text", "")[:500])
            else:
                print(f"[UNAVAILABLE] {data.get('text', '')[:200]}")


if __name__ == "__main__":
    main()
