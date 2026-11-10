# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""An agent's Markdown reply as the HTML a message body holds.

Agents answer in Markdown (or plain text, which is Markdown too). This turns the common parts of it into the HTML the
message composer makes: paragraphs and line breaks, bold, italics, strikethrough, inline code, fenced code blocks,
bulleted and numbered lists, block quotes, headings (as bold paragraphs) and links. Anything else stays as text.

Nothing the agent writes becomes markup by itself: the text is HTML-escaped before any of it is converted, the only
tags in the result are the ones made here, and links keep http(s) and mailto addresses only. The result then goes
through the same sanitizer as every message from the composer (`validate_html_content`).
"""

import re
from html import escape

from plane.utils.content_validator import validate_html_content

# Where an inline element made here sits while the rest of the line is converted: private-use characters an agent's
# text can't usefully contain (they are removed from it first).
_HOLD_START, _HOLD_END = "", ""
_HOLD = re.compile(f"{_HOLD_START}(\\d+){_HOLD_END}")

_FENCE = re.compile(r"^\s{0,3}(```|~~~)")
# The closing `#`s are taken off in `_heading_text`: a pattern for them backtracks badly on long runs of spaces.
_HEADING = re.compile(r"^\s{0,3}#{1,6}[ \t](.*)$")
_BULLET = re.compile(r"^\s{0,3}[-*+]\s+(.*)$")
_NUMBERED = re.compile(r"^\s{0,3}\d{1,9}[.)]\s+(.*)$")
_QUOTE = re.compile(r"^\s{0,3}&gt;\s?(.*)$")
_RULE = re.compile(r"^\s{0,3}([-*_])(\s*\1){2,}\s*$")

# Code spans are found by `_code_spans`, run by run: a backreference pattern takes cubic time on long runs.
_BACKTICKS = re.compile(r"`+")
# [text](url) after escaping. Neither part may hold brackets, nor the URL spaces or parentheses, so that each try at a
# match ends at the next bracket and the time stays linear in the line's length.
_LINK = re.compile(r"\[([^\[\]\n]+)\]\(([^\s()\[\]]+)\)")
# <https://...> after escaping.
_AUTOLINK = re.compile(r"&lt;((?:https?://|mailto:)[^\s&]+(?:&amp;[^\s&]+)*)&gt;")
_BARE_URL = re.compile(r"(?<![\w/])(https?://[^\s<]+[^\s<.,;:!?)\]'\"])")
# Emphasis can't hold its own marker, so each try at a match ends at the next one (no emphasis nested in the same kind).
_BOLD = re.compile(r"(?<![\w*])\*\*(?=\S)([^*]+)(?<=\S)\*\*(?![\w*])|(?<![\w_])__(?=\S)([^_]+)(?<=\S)__(?![\w_])")
_ITALIC = re.compile(r"(?<![\w*])\*(?=\S)([^*]+)(?<=\S)\*(?![\w*])|(?<![\w_])_(?=\S)([^_]+)(?<=\S)_(?![\w_])")
_STRIKE = re.compile(r"~~(?=\S)([^~]+)(?<=\S)~~")

_SAFE_SCHEMES = ("http://", "https://", "mailto:")
# Emphasis and bare URLs are matched only in lines up to this long (after escaping). Their patterns take time growing
# with the square of the line's length when nothing closes them, and an agent's text is not to be trusted with that.
MAX_INLINE_CHARS = 4_000


def _link(href, text):
    # `href` is already escaped text, so it can't leave the attribute. The sanitizer adds `rel`.
    return f'<a href="{href}" target="_blank">{text}</a>'


def _safe_href(escaped_url):
    return escaped_url.lower().startswith(_SAFE_SCHEMES)


def _code_spans(text, hold):
    """`text` with each code span held: a run of backticks up to the next run of exactly as many (as in CommonMark)."""
    runs = list(_BACKTICKS.finditer(text))
    # For each run, the next run of the same length, found in one pass from the end.
    closing, last_of_length = [None] * len(runs), {}
    for index in range(len(runs) - 1, -1, -1):
        length = len(runs[index].group())
        closing[index] = last_of_length.get(length)
        last_of_length[length] = index
    out, position, index = [], 0, 0
    while index < len(runs):
        close = closing[index]
        if close is None:
            index += 1
            continue
        opening, ending = runs[index], runs[close]
        out.append(text[position : opening.start()])
        out.append(hold(f"<code>{text[opening.end() : ending.start()].strip()}</code>"))
        position = ending.end()
        index = close + 1
    out.append(text[position:])
    return "".join(out)


def _heading_text(text):
    """A heading's text without its closing `#`s, which need a space before them (`C#` keeps its `#`)."""
    text = text.strip()
    without = text.rstrip("#")
    if without != text and (not without or without[-1] in " \t"):
        return without.rstrip()
    return text


def _inline(text):
    """One line or paragraph of escaped text with its inline Markdown converted."""
    held = []

    def hold(html):
        held.append(html)
        return f"{_HOLD_START}{len(held) - 1}{_HOLD_END}"

    text = _code_spans(text, hold)
    text = _LINK.sub(
        lambda m: hold(_link(m.group(2), m.group(1))) if _safe_href(m.group(2)) else m.group(1),
        text,
    )
    text = _AUTOLINK.sub(lambda m: hold(_link(m.group(1), m.group(1))), text)
    if len(text) <= MAX_INLINE_CHARS:
        text = _BARE_URL.sub(lambda m: hold(_link(m.group(1), m.group(1))), text)
        text = _BOLD.sub(lambda m: f"<strong>{m.group(1) or m.group(2)}</strong>", text)
        text = _ITALIC.sub(lambda m: f"<em>{m.group(1) or m.group(2)}</em>", text)
        text = _STRIKE.sub(r"<s>\1</s>", text)
    # Held items can hold others (a link's text with code in it), so restore until none are left.
    while _HOLD.search(text):
        text = _HOLD.sub(lambda m: held[int(m.group(1))], text)
    return text


def _paragraph(lines):
    return "<p>" + "<br>".join(_inline(line.strip()) for line in lines) + "</p>"


def _blocks(lines):
    """The block-level HTML of escaped Markdown `lines`."""
    out = []
    i = 0
    while i < len(lines):
        line = lines[i]
        if not line.strip():
            i += 1
            continue
        if _FENCE.match(line):
            fence = _FENCE.match(line).group(1)
            code = []
            i += 1
            while i < len(lines) and not lines[i].strip().startswith(fence):
                code.append(lines[i])
                i += 1
            i += 1  # the closing fence, or the end
            out.append("<pre><code>" + "\n".join(code) + "</code></pre>")
            continue
        if _RULE.match(line):
            out.append("<hr>")
            i += 1
            continue
        heading = _HEADING.match(line)
        if heading:
            out.append(f"<p><strong>{_inline(_heading_text(heading.group(1)))}</strong></p>")
            i += 1
            continue
        if _QUOTE.match(line):
            quoted = []
            while i < len(lines) and _QUOTE.match(lines[i]):
                quoted.append(_QUOTE.match(lines[i]).group(1))
                i += 1
            out.append("<blockquote>" + "".join(_blocks(quoted)) + "</blockquote>")
            continue
        for pattern, tag in ((_BULLET, "ul"), (_NUMBERED, "ol")):
            if pattern.match(line):
                items = []
                while i < len(lines) and lines[i].strip():
                    item = pattern.match(lines[i])
                    if item:
                        items.append([item.group(1)])
                    elif items and lines[i].startswith((" ", "\t")):
                        # A wrapped item continues on an indented line.
                        items[-1].append(lines[i])
                    else:
                        break
                    i += 1
                out.append(f"<{tag}>" + "".join(f"<li>{_paragraph(item)}</li>" for item in items) + f"</{tag}>")
                break
        else:
            paragraph = [line]
            i += 1
            while i < len(lines) and lines[i].strip() and not _starts_block(lines[i]):
                paragraph.append(lines[i])
                i += 1
            out.append(_paragraph(paragraph))
    return out


def _starts_block(line):
    return any(p.match(line) for p in (_FENCE, _HEADING, _BULLET, _NUMBERED, _QUOTE, _RULE))


def markdown_to_html(markdown, max_chars):
    """Safe message HTML for `markdown`, cut to `max_chars` characters of Markdown first (marked with an ellipsis)."""
    text = (markdown or "").replace("\r\n", "\n").replace("\r", "\n")
    text = text.replace(_HOLD_START, "").replace(_HOLD_END, "").replace("\x00", "")
    text = text.strip()
    if len(text) > max_chars:
        text = text[:max_chars].rstrip() + " …"
    html = "".join(_blocks(escape(text, quote=True).split("\n")))
    is_valid, _error, clean_html = validate_html_content(html)
    if not is_valid:
        # The sanitizer refused it: fall back to the escaped text, one paragraph per line.
        return "".join(f"<p>{escape(line)}</p>" for line in text.split("\n") if line.strip())
    return clean_html if clean_html is not None else html
