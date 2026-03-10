"""Lightweight OpenMetadata REST API client."""

from __future__ import annotations

import base64
from dataclasses import dataclass, field
from typing import Any

import httpx


@dataclass
class OMTable:
    """A table from OpenMetadata with its columns."""

    fqn: str
    name: str
    database: str
    schema_name: str
    service: str
    table_type: str
    description: str
    columns: list[OMColumn] = field(default_factory=list)
    tags: list[str] = field(default_factory=list)


@dataclass
class OMColumn:
    """A column from OpenMetadata."""

    name: str
    data_type: str
    description: str
    tags: list[str] = field(default_factory=list)


class OpenMetadataClient:
    """Client for OpenMetadata REST API v1."""

    def __init__(self, base_url: str, email: str = "admin@open-metadata.org", password: str = "admin"):
        self.base_url = base_url.rstrip("/")
        self._email = email
        self._password = password
        self._token: str | None = None

    def _get_token(self) -> str:
        if self._token:
            return self._token

        b64_pass = base64.b64encode(self._password.encode()).decode()
        resp = httpx.post(
            f"{self.base_url}/api/v1/users/login",
            json={"email": self._email, "password": b64_pass},
            timeout=10,
        )
        resp.raise_for_status()
        self._token = resp.json()["accessToken"]
        return self._token

    def _get(self, path: str, params: dict[str, Any] | None = None) -> dict:
        token = self._get_token()
        resp = httpx.get(
            f"{self.base_url}{path}",
            headers={"Authorization": f"Bearer {token}"},
            params=params or {},
            timeout=15,
        )
        resp.raise_for_status()
        return resp.json()

    def list_database_services(self) -> list[dict]:
        """List all database services."""
        data = self._get("/api/v1/services/databaseServices", {"limit": 100})
        return data.get("data", [])

    def list_tables(self, service_fqn: str) -> list[OMTable]:
        """List all tables for a given database service, with columns."""
        tables: list[OMTable] = []
        after: str | None = None

        while True:
            params: dict[str, Any] = {
                "service": service_fqn,
                "limit": 50,
                "fields": "columns,tags",
            }
            if after:
                params["after"] = after

            data = self._get("/api/v1/tables", params)

            for t in data.get("data", []):
                fqn = t.get("fullyQualifiedName", "")
                parts = fqn.split(".")
                # FQN: service.database.schema.table
                service = parts[0] if len(parts) > 0 else ""
                database = parts[1] if len(parts) > 1 else ""
                schema_name = parts[2] if len(parts) > 2 else ""

                columns = []
                for c in t.get("columns", []):
                    col_tags = [tag["tagFQN"] for tag in c.get("tags", [])]
                    columns.append(
                        OMColumn(
                            name=c["name"],
                            data_type=c.get("dataType", "UNKNOWN"),
                            description=c.get("description", ""),
                            tags=col_tags,
                        )
                    )

                table_tags = [tag["tagFQN"] for tag in t.get("tags", [])]

                tables.append(
                    OMTable(
                        fqn=fqn,
                        name=t["name"],
                        database=database,
                        schema_name=schema_name,
                        service=service,
                        table_type=t.get("tableType", "Regular"),
                        description=t.get("description", ""),
                        columns=columns,
                        tags=table_tags,
                    )
                )

            paging = data.get("paging", {})
            after = paging.get("after")
            if not after:
                break

        return tables

    def health_check(self) -> bool:
        """Check if OM is reachable."""
        try:
            resp = httpx.get(f"{self.base_url}/api/v1/system/version", timeout=5)
            return resp.status_code == 200
        except Exception:
            return False
