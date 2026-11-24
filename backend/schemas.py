from __future__ import annotations

import json
import time
from typing import Annotated, Any, Literal, Union

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, field_validator


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


def _coerce_none_to_list(v: Any) -> Any:
    if v is None:
        return []
    return v


# ---------------------------------------------------------------------------
# Inbound (Client -> Cloud)
# ---------------------------------------------------------------------------


class PinnedNote(StrictModel):
    note_id: str = ""
    source_url: str = ""
    text: str


class DispatchSwarm(StrictModel):
    type: Literal["DISPATCH_SWARM"]
    job_id: str
    intent: str
    constraints: list[str] = Field(default_factory=list)
    context_url: str | None = None
    pinned_notes: list[PinnedNote] = Field(default_factory=list)

    _coerce_constraints = field_validator("constraints", mode="before")(_coerce_none_to_list)
    _coerce_pinned_notes = field_validator("pinned_notes", mode="before")(_coerce_none_to_list)


class SteerSwarm(StrictModel):
    type: Literal["STEER_SWARM"]
    job_id: str
    delta_instruction: str = ""
    cancel_domains: list[str] = Field(default_factory=list)

    _coerce_cancel_domains = field_validator("cancel_domains", mode="before")(_coerce_none_to_list)


class ApprovalDecision(StrictModel):
    type: Literal["APPROVAL_DECISION"]
    gate_id: str
    approved: bool


ClientMessage = Annotated[
    Union[DispatchSwarm, SteerSwarm, ApprovalDecision],
    Field(discriminator="type"),
]

CLIENT_ADAPTER: TypeAdapter[ClientMessage] = TypeAdapter(ClientMessage)


def parse_client_message(raw: str | dict[str, Any]) -> ClientMessage:
    """Parse and validate a raw JSON string or dict into a ClientMessage."""
    if isinstance(raw, str):
        data = json.loads(raw)
    else:
        data = raw
    return CLIENT_ADAPTER.validate_python(data)


# ---------------------------------------------------------------------------
# Outbound (Cloud -> Client)
# ---------------------------------------------------------------------------


class Telemetry(StrictModel):
    type: Literal["TELEMETRY"] = "TELEMETRY"
    trace_id: str
    agent_id: Literal["scout_swarm", "synthesis", "gatekeeper"]
    status: Literal["RUNNING", "COMPLETED", "CANCELLED", "BLOCKED"]
    message: str
    latency_ms: int
    workers_active: int
    tabs_offloaded: int


class SynthesisItem(StrictModel):
    name: str
    price: str = ""
    pros: list[str] = Field(default_factory=list)
    cons: list[str] = Field(default_factory=list)
    url: str = ""


class EvidenceCard(StrictModel):
    source_url: str = ""
    title: str = ""
    sanitized_excerpt: str
    quote_to_highlight: str


class ContradictionItem(StrictModel):
    claim: str
    conflict: str
    source_url: str = ""
    quote_to_highlight: str = ""


class MindMapNode(StrictModel):
    id: str
    label: str
    source_url: str = ""


class MindMapEdge(StrictModel):
    from_: str = Field(alias="from")
    to: str
    label: str = ""


class MindMapData(StrictModel):
    nodes: list[MindMapNode] = Field(default_factory=list)
    edges: list[MindMapEdge] = Field(default_factory=list)

    _coerce_nodes = field_validator("nodes", mode="before")(_coerce_none_to_list)
    _coerce_edges = field_validator("edges", mode="before")(_coerce_none_to_list)


class SynthesisUpdate(StrictModel):
    type: Literal["SYNTHESIS_UPDATE"] = "SYNTHESIS_UPDATE"
    job_id: str
    voice_brief: str
    items: list[SynthesisItem] = Field(default_factory=list)
    evidence_cards: list[EvidenceCard] = Field(default_factory=list)
    contradictions: list[ContradictionItem] = Field(default_factory=list)
    mind_map: MindMapData = Field(default_factory=MindMapData)

    _coerce_items = field_validator("items", mode="before")(_coerce_none_to_list)
    _coerce_evidence = field_validator("evidence_cards", mode="before")(_coerce_none_to_list)
    _coerce_contradictions = field_validator("contradictions", mode="before")(_coerce_none_to_list)


class GatekeeperIntercept(StrictModel):
    type: Literal["GATEKEEPER_INTERCEPT"] = "GATEKEEPER_INTERCEPT"
    gate_id: str
    decision: Literal["FORBID_UNTIL_SIGNED"] = "FORBID_UNTIL_SIGNED"
    cedar_rule: str
    action_type: Literal["FORM_SUBMIT", "CHECKOUT_CLICK", "EXTERNAL_POST"]
    target_url: str
    reason: str
    action_diff: str


CloudMessage = Annotated[
    Union[Telemetry, SynthesisUpdate, GatekeeperIntercept],
    Field(discriminator="type"),
]

CLOUD_ADAPTER: TypeAdapter[CloudMessage] = TypeAdapter(CloudMessage)
