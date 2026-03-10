from enum import Enum

from pydantic import AliasChoices, BaseModel, Field

# ── Node types ──


class NodeType(str, Enum):
    Bundle = "Bundle"
    Table = "Table"
    Column = "Column"
    Model = "Model"
    Dimension = "Dimension"
    Measure = "Measure"
    Rule = "Rule"
    Classification = "Classification"
    Policy = "Policy"
    JoinEdge = "JoinEdge"
    Contract = "Contract"
    PolicyCheck = "PolicyCheck"


# ── Edge types ──


class EdgeType(str, Enum):
    # Phase 1: structural edges
    DEFINES = "DEFINES"
    APPLIES_TO = "APPLIES_TO"
    BLOCKS = "BLOCKS"
    REQUIRES_TIME_FILTER = "REQUIRES_TIME_FILTER"
    JOINS_WITH = "JOINS_WITH"
    CONTAINS = "CONTAINS"
    READS = "READS"
    AGGREGATES = "AGGREGATES"
    FILTERS_ON = "FILTERS_ON"
    CLASSIFIES = "CLASSIFIES"
    WRAPS = "WRAPS"
    ALLOWS_JOIN = "ALLOWS_JOIN"
    JOIN_LEFT = "JOIN_LEFT"
    JOIN_RIGHT = "JOIN_RIGHT"

    # Phase 2: contract edges
    TOUCHED = "TOUCHED"
    USED = "USED"
    REFERENCED = "REFERENCED"
    DECIDED = "DECIDED"
    FAILED = "FAILED"


# ── Graph primitives ──


class GraphNode(BaseModel):
    id: str
    type: NodeType
    properties: dict = Field(default_factory=dict)


class GraphEdge(BaseModel):
    from_: str = Field(
        validation_alias=AliasChoices("from_", "from"),
        serialization_alias="from",
    )
    to: str
    type: EdgeType

    model_config = {"populate_by_name": True}


# ── Query result types ──


class GraphStats(BaseModel):
    nodes_by_type: dict[str, int] = Field(default_factory=dict)
    edges_by_type: dict[str, int] = Field(default_factory=dict)


class GapEntry(BaseModel):
    node_id: str
    node_type: NodeType
    missing_edge: EdgeType
    description: str


class GapReport(BaseModel):
    removed: list[str] = Field(default_factory=list)
    new_gaps: list[GapEntry] = Field(default_factory=list)


class GraphJSON(BaseModel):
    nodes: list[GraphNode] = Field(default_factory=list)
    edges: list[GraphEdge] = Field(default_factory=list)
