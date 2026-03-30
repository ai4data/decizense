from pathlib import Path

import yaml
from pydantic import BaseModel, Field


class BusinessRule(BaseModel):
    name: str
    category: str
    severity: str = "info"
    applies_to: list[str] = Field(default_factory=list)
    description: str
    guidance: str


class Classification(BaseModel):
    name: str
    description: str
    condition: str | None = None
    columns: list[str] = Field(default_factory=list)
    tags: list[str] = Field(default_factory=list)
    characteristics: dict[str, str] = Field(default_factory=dict)


class BusinessRules(BaseModel):
    rules: list[BusinessRule]
    classifications: list[Classification] = Field(default_factory=list)

    @classmethod
    def load(cls, project_path: Path) -> "BusinessRules | None":
        yaml_path = project_path / "semantics" / "business_rules.yml"
        if not yaml_path.exists():
            return None
        data = yaml.safe_load(yaml_path.read_text())
        if "classifications" in data and isinstance(data["classifications"], dict):
            data["classifications"] = [{"name": name, **value} for name, value in data["classifications"].items()]
        return cls.model_validate(data)

    def filter_by_category(self, category: str) -> list[BusinessRule]:
        return [r for r in self.rules if r.category == category]

    def filter_by_concept(self, concepts: list[str]) -> list[BusinessRule]:
        return [r for r in self.rules if any(c in r.applies_to for c in concepts)]

    def get_categories(self) -> list[str]:
        return sorted({r.category for r in self.rules})

    def get_classification(self, name: str) -> Classification | None:
        return next((c for c in self.classifications if c.name == name), None)

    def filter_classifications_by_tags(self, tags: list[str]) -> list[Classification]:
        return [c for c in self.classifications if any(t in c.tags for t in tags)]

    def get_classification_names(self) -> list[str]:
        return [c.name for c in self.classifications]
