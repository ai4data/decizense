from pydantic import BaseModel, Field

from dazense_core.ui import UI, ask_confirm, ask_select, ask_text


class CatalogConfig(BaseModel):
    """Catalog platform configuration (OpenMetadata, Atlan, Collibra, Purview, etc.)."""

    provider: str = Field(
        default="openmetadata", description="Catalog provider (openmetadata, atlan, collibra, purview)"
    )
    url: str = Field(default="http://localhost:8585", description="Catalog server URL")
    token: str | None = Field(default=None, description="Bot/service account JWT token (preferred auth)")
    email: str = Field(default="admin@open-metadata.org", description="Login email (fallback auth)")
    password: str = Field(default="admin", description="Login password (fallback auth)")
    services: list[str] = Field(default_factory=list, description="Service names to sync (empty = all)")
    tag_mappings: dict[str, str] = Field(
        default_factory=lambda: {"PII": "PII", "Sensitive": "PII", "PersonalData": "PII"},
        description="Map catalog tag prefixes to graph classification names",
    )

    @classmethod
    def promptConfig(cls) -> "CatalogConfig":
        """Interactively prompt the user for catalog configuration."""
        provider = ask_select(
            "Catalog provider:",
            choices=["openmetadata", "atlan", "collibra", "purview", "other"],
            default="openmetadata",
        )

        url = ask_text("Catalog URL:", default="http://localhost:8585")
        token = ask_text("Bot/service account token (optional):", required_field=False)

        services: list[str] = []
        if ask_confirm("Restrict sync to specific services?", default=True):
            UI.info("Enter service names to sync (comma-separated):")
            services_input = ask_text("Services:", required_field=True)
            services = [s.strip() for s in services_input.split(",") if s.strip()]  # type: ignore

        return CatalogConfig(
            provider=provider,
            url=url,  # type: ignore
            token=token if token else None,
            services=services,
        )
