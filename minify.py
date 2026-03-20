"""
minify.py — Run this before every git push to regenerate minified files.

Usage:
    python3 minify.py
"""

import re
import os


def minify_js(src):
    # Remove single-line comments (but not URLs like https://)
    src = re.sub(r"(?<!:)//(?!/).*$", "", src, flags=re.MULTILINE)
    # Remove multi-line comments
    src = re.sub(r"/\*.*?\*/", "", src, flags=re.DOTALL)
    # Remove extra blank lines
    src = re.sub(r"\n{3,}", "\n\n", src)
    # Strip trailing whitespace per line
    lines = [line.rstrip() for line in src.split("\n")]
    return "\n".join(lines).strip()


def minify_css(src):
    # Remove comments
    src = re.sub(r"/\*.*?\*/", "", src, flags=re.DOTALL)
    # Collapse whitespace
    src = re.sub(r"\s+", " ", src)
    # Remove spaces around punctuation
    src = re.sub(r"\s*{\s*", "{", src)
    src = re.sub(r"\s*}\s*", "}", src)
    src = re.sub(r"\s*:\s*", ":", src)
    src = re.sub(r"\s*;\s*", ";", src)
    src = re.sub(r"\s*,\s*", ",", src)
    return src.strip()


def main():
    base = os.path.dirname(os.path.abspath(__file__))
    static = os.path.join(base, "static")

    files = [
        ("app.js", "app.min.js", minify_js),
        ("style.css", "style.min.css", minify_css),
    ]

    for src_name, out_name, minify_fn in files:
        src_path = os.path.join(static, src_name)
        out_path = os.path.join(static, out_name)

        with open(src_path, "r", encoding="utf-8") as f:
            src = f.read()

        minified = minify_fn(src)

        with open(out_path, "w", encoding="utf-8") as f:
            f.write(minified)

        original_kb = len(src.encode()) / 1024
        minified_kb = len(minified.encode()) / 1024
        savings = 100 * (1 - minified_kb / original_kb)

        print(
            f"✅ {src_name:15} {original_kb:6.1f}KB → {minified_kb:6.1f}KB  ({savings:.0f}% smaller)"
        )

    print("\nDone! Safe to git push now. 🚀")


if __name__ == "__main__":
    main()
