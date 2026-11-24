from __future__ import annotations

import asyncio
import re
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlparse

from bs4 import BeautifulSoup, Comment, Tag

_HIDDEN_STYLE_RE = re.compile(
    r"(?:display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(?:\.0+)?(?:\s*;|\s*$)|font-size\s*:\s*0(?:px|em|rem|%)?(?:\s*;|\s*$))",
    re.IGNORECASE,
)

_INJECTION_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (
        re.compile(
            r"\b(?:ignore\s+(?:previous|all)\s+instructions|system\s+override|disregard\s+rules)\b",
            re.IGNORECASE,
        ),
        "prompt_override_instruction",
    ),
    (
        re.compile(
            r"\b(?:auto-?submit|click\s+(?:buy|checkout|submit)|execute\s+checkout|submit\s+form\s+immediately|post\s+to\s+external)\b",
            re.IGNORECASE,
        ),
        "dom_action_instruction",
    ),
]

_AUTO_SUBMIT_SCRIPT_RE = re.compile(
    r"(?:\.submit\s*\(|requestSubmit\s*\(|fetch\s*\(.*?(?:checkout|order|purchase|submit))",
    re.IGNORECASE | re.DOTALL,
)


def sanitize_html(html: str, max_chars: int = 6000) -> str:
    """Strip unsafe/hidden elements and comments, collapse whitespace, and cap length."""
    soup = BeautifulSoup(html or "", "html.parser")

    for comment in soup.find_all(string=lambda text: isinstance(text, Comment)):
        comment.extract()

    for tag_name in ("script", "style", "noscript", "template", "iframe", "svg"):
        for tag in soup.find_all(tag_name):
            tag.decompose()

    # Collect elements to remove first so we don't mutate during iteration.
    to_remove: list[Tag] = []
    for tag in soup.find_all(True):
        if not isinstance(tag, Tag) or tag.attrs is None:
            continue
        if tag.has_attr("hidden"):
            to_remove.append(tag)
            continue
        aria_hidden = tag.get("aria-hidden")
        if isinstance(aria_hidden, str) and aria_hidden.strip().lower() == "true":
            to_remove.append(tag)
            continue
        style = tag.get("style")
        if isinstance(style, str) and _HIDDEN_STYLE_RE.search(style):
            to_remove.append(tag)
            continue

    for tag in to_remove:
        tag.decompose()

    text = soup.get_text(separator=" ", strip=True)
    collapsed = re.sub(r"\s+", " ", text).strip()
    if max_chars > 0 and len(collapsed) > max_chars:
        return collapsed[:max_chars]
    return collapsed


@dataclass
class TaintedPayload:
    source_url: str
    title: str
    text: str
    source_trust: str = "UNTRUSTED_WEB"
    forms: list[str] = field(default_factory=list)
    injected_actions: list[str] = field(default_factory=list)


def inspect_and_sanitize_html(
    html: str,
    source_url: str,
    max_chars: int = 6000,
) -> TaintedPayload:
    """Inspect raw HTML for forms and DOM action injections, then return a TaintedPayload."""
    soup = BeautifulSoup(html or "", "html.parser")
    title = ""
    if soup.title and soup.title.string:
        title = re.sub(r"\s+", " ", soup.title.string).strip()

    forms: list[str] = []
    for form in soup.find_all("form"):
        action = str(form.get("action") or "").strip()
        method = str(form.get("method") or "GET").strip().upper()
        forms.append(f"{method} {action}".strip())

    injected_actions: list[str] = []
    for script in soup.find_all("script"):
        script_text = script.get_text() or ""
        if _AUTO_SUBMIT_SCRIPT_RE.search(script_text):
            injected_actions.append("auto_submit_script")

    raw_text = soup.get_text(separator=" ", strip=True)
    for pattern, label in _INJECTION_PATTERNS:
        if pattern.search(raw_text):
            if label not in injected_actions:
                injected_actions.append(label)

    sanitized = sanitize_html(html, max_chars=max_chars)
    return TaintedPayload(
        source_url=source_url,
        title=title,
        text=sanitized,
        source_trust="UNTRUSTED_WEB",
        forms=forms,
        injected_actions=injected_actions,
    )


# ---------------------------------------------------------------------------
# Cedar-style Policy Engine
# ---------------------------------------------------------------------------

CEDAR_POLICY_TEXT = """
@id("permit_public_https_read")
permit(
  principal,
  action == Action::"READ_FETCH",
  resource
) when {
  resource.scheme == "https"
};

@id("forbid_untrusted_mutating_action")
forbid(
  principal,
  action in [Action::"FORM_SUBMIT", Action::"CHECKOUT_CLICK", Action::"EXTERNAL_POST", Action::"UNKNOWN_MUTATING"],
  resource
) when {
  context.source_trust == "UNTRUSTED_WEB"
};
""".strip()

CEDAR_POLICIES: list[dict[str, Any]] = [
    {
        "id": "permit_public_https_read",
        "effect": "permit",
        "actions": ["READ_FETCH"],
        "condition": {"scheme": "https"},
    },
    {
        "id": "forbid_untrusted_mutating_action",
        "effect": "forbid",
        "actions": ["FORM_SUBMIT", "CHECKOUT_CLICK", "EXTERNAL_POST", "UNKNOWN_MUTATING"],
        "condition": {"source_trust": "UNTRUSTED_WEB"},
    },
]

_MUTATING_ACTIONS = {"FORM_SUBMIT", "CHECKOUT_CLICK", "EXTERNAL_POST", "UNKNOWN_MUTATING"}


@dataclass(frozen=True)
class Decision:
    allowed: bool
    decision: str
    rule_id: str
    reason: str


def evaluate(
    action_type: str,
    target_url: str,
    taint: TaintedPayload | None = None,
) -> Decision:
    """Evaluate Cedar-style policies; forbid overrides permit and unknown mutating actions deny."""
    action = action_type.strip().upper()
    parsed = urlparse(target_url)
    source_trust = taint.source_trust if taint is not None else "UNTRUSTED_WEB"

    # Forbid rules always take precedence.
    if action in _MUTATING_ACTIONS and source_trust == "UNTRUSTED_WEB":
        return Decision(
            allowed=False,
            decision="FORBID_UNTIL_SIGNED",
            rule_id="forbid_untrusted_mutating_action",
            reason=f"Mutating action '{action}' blocked for {source_trust} target.",
        )

    if action == "READ_FETCH":
        if parsed.scheme.lower() == "https":
            return Decision(
                allowed=True,
                decision="ALLOW",
                rule_id="permit_public_https_read",
                reason="Public HTTPS read-only fetch permitted.",
            )
        return Decision(
            allowed=False,
            decision="DENY",
            rule_id="deny_non_https_read",
            reason="Only HTTPS scheme is permitted for READ_FETCH.",
        )

    # Unknown mutating or unrecognized actions are denied by default.
    return Decision(
        allowed=False,
        decision="DENY",
        rule_id="default_deny",
        reason=f"Action '{action}' is denied by default.",
    )


# ---------------------------------------------------------------------------
# Per-session GateRegistry
# ---------------------------------------------------------------------------


class GateRegistry:
    """Manages pending human-in-the-loop approval gates for a WebSocket session."""

    def __init__(self) -> None:
        self._events: dict[str, asyncio.Event] = {}
        self._decisions: dict[str, bool] = {}

    def create(self, gate_id: str) -> asyncio.Event:
        event = asyncio.Event()
        self._events[gate_id] = event
        return event

    async def await_approval(self, gate_id: str, timeout: float = 300.0) -> bool:
        event = self._events.get(gate_id)
        if event is None:
            return False
        try:
            await asyncio.wait_for(event.wait(), timeout=timeout)
            return bool(self._decisions.get(gate_id, False))
        except asyncio.TimeoutError:
            return False
        except asyncio.CancelledError:
            raise
        finally:
            self._events.pop(gate_id, None)
            self._decisions.pop(gate_id, None)

    def discard(self, gate_id: str) -> None:
        self._events.pop(gate_id, None)
        self._decisions.pop(gate_id, None)

    def resolve(self, gate_id: str, approved: bool) -> None:
        event = self._events.get(gate_id)
        if event is None:
            return
        if gate_id not in self._decisions:
            self._decisions[gate_id] = approved
        event.set()

    def cancel_all(self) -> None:
        for gate_id, event in list(self._events.items()):
            if gate_id not in self._decisions:
                self._decisions[gate_id] = False
            event.set()
        self._events.clear()
