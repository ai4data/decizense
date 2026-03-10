from enum import Enum
from pathlib import Path

import yaml
from pydantic import BaseModel, Field, model_validator


class AggregationType(str, Enum):
    COUNT = "count"
    SUM = "sum"
    AVG = "avg"
    MIN = "min"
    MAX = "max"
    COUNT_DISTINCT = "count_distinct"


class JoinType(str, Enum):
    MANY_TO_ONE = "many_to_one"
    ONE_TO_ONE = "one_to_one"
    ONE_TO_MANY = "one_to_many"


class Dimension(BaseModel):
    column: str
    description: str | None = None


class MeasureFilter(BaseModel):
    column: str
    operator: str = "eq"
    value: str | int | float | bool | list | None = None


class Measure(BaseModel):
    type: AggregationType
    column: str | None = None
    description: str | None = None
    filters: list[MeasureFilter] = Field(default_factory=list)

    @model_validator(mode="after")
    def validate_column_required(self) -> "Measure":
        if self.type != AggregationType.COUNT and self.column is None:
            raise ValueError(f"Measure with type '{self.type.value}' requires a 'column' field")
        return self


class JoinDefinition(BaseModel):
    to_model: str
    foreign_key: str
    related_key: str
    type: JoinType = JoinType.MANY_TO_ONE


class ModelDefinition(BaseModel):
    table: str
    schema_name: str = Field(alias="schema", default="main")
    database: str | None = None
    description: str | None = None
    primary_key: str | None = None
    time_dimension: str | None = None
    dimensions: dict[str, Dimension] = Field(default_factory=dict)
    measures: dict[str, Measure] = Field(default_factory=dict)
    joins: dict[str, JoinDefinition] = Field(default_factory=dict)

    model_config = {"populate_by_name": True}


class SemanticModel(BaseModel):
    models: dict[str, ModelDefinition]

    @classmethod
    def load(cls, project_path: Path) -> "SemanticModel | None":
        yaml_path = project_path / "semantics" / "semantic_model.yml"
        if not yaml_path.exists():
            return None
        data = yaml.safe_load(yaml_path.read_text())
        return cls.model_validate(data)

    def get_model(self, name: str) -> ModelDefinition | None:
        return self.models.get(name)

    def list_models(self) -> list[str]:
        return list(self.models.keys())
