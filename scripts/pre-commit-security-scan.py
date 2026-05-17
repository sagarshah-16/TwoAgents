#!/usr/bin/env python3
"""Scan tracked paths for common secret patterns before commit."""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

SKIP_DIRS = {
    "node_modules",
    ".git",
    "dist",
    "dist-electron",
    "coverage",
    ".vite",
    ".tools",
}

SKIP_FILES = {
    "package-lock.json",
    "pre-commit-security-scan.py",
}

SCAN_EXTENSIONS = {
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".json",
    ".html",
    ".css",
    ".md",
    ".yml",
    ".yaml",
    ".env",
    ".example",
    ".sh",
    ".cjs",
    ".cts",
    ".mjs",
}

RULES: list[tuple[str, re.Pattern[str]]] = [
    ("GitHub personal access token", re.compile(r"ghp_[A-Za-z0-9]{20,}")),
    ("GitHub fine-grained token", re.compile(r"github_pat_[A-Za-z0-9_]{20,}")),
    ("OpenAI API key", re.compile(r"sk-[A-Za-z0-9]{20,}")),
    ("Anthropic API key", re.compile(r"sk-ant-[A-Za-z0-9\-]{20,}")),
    ("AWS access key", re.compile(r"AKIA[0-9A-Z]{16}")),
    ("Private key block", re.compile(r"-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----")),
    (
        "High-entropy assignment (review manually)",
        re.compile(
            r"(?i)(?:api[_-]?key|secret|password|token|auth)\s*[=:]\s*['\"][^'\"\\s]{12,}['\"]"
        ),
    ),
]


def iter_files() -> list[Path]:
    files: list[Path] = []
    for path in ROOT.rglob("*"):
        if not path.is_file():
            continue
        if any(part in SKIP_DIRS for part in path.parts):
            continue
        if path.name in SKIP_FILES:
            continue
        if path.suffix and path.suffix not in SCAN_EXTENSIONS:
            if path.name not in {".gitignore", ".env", ".env.example"}:
                continue
        files.append(path)
    return sorted(files)


def main() -> int:
    findings: list[str] = []
    for path in iter_files():
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError as exc:
            findings.append(f"{path.relative_to(ROOT)}: unreadable ({exc})")
            continue
        rel = path.relative_to(ROOT)
        for label, pattern in RULES:
            for match in pattern.finditer(text):
                line = text.count("\n", 0, match.start()) + 1
                findings.append(f"{rel}:{line}: possible {label}")

    if findings:
        print("SECURITY SCAN FAILED — possible secrets detected:\n")
        for item in findings:
            print(f"  - {item}")
        return 1

    print(f"SECURITY SCAN PASSED ({len(iter_files())} files checked, no secret patterns found).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
