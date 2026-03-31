from pydantic import BaseModel, Field

from dazense_core.ui import UI, ask_confirm, ask_text


class OpenMetadataConfig(BaseModel):
    """OpenMetadata integration configuration."""

    url: str = Field(default="http://localhost:8585", description="OpenMetadata server URL")
    token: str | None = Field(default=None, description="Bot JWT token (preferred auth method)")
    email: str = Field(default="admin@open-metadata.org", description="Login email (fallback auth)")
    password: str = Field(default="admin", description="Login password (fallback auth)")
    services: list[str] = Field(default_factory=list, description="Service names to sync (empty = all)")
    tag_mappings: dict[str, str] = Field(
        default_factory=lambda: {"PII": "PII", "Sensitive": "PII", "PersonalData": "PII"},
        description="Map OM tag prefixes to graph classification names",
    )

    @classmethod
    def promptConfig(cls) -> "OpenMetadataConfig":
        """Interactively prompt the user for OpenMetadata configuration."""
        url = ask_text("OpenMetadata URL:", default="http://localhost:8585")

        email = ask_text("Email:", default="admin@open-metadata.org")
        password = ask_text("Password:", default="admin", password=True)

        services: list[str] = []
        if ask_confirm("Restrict sync to specific services?", default=True):
            UI.info("Enter service names to sync (comma-separated):")
            services_input = ask_text("Services:", required_field=True)
            services = [s.strip() for s in services_input.split(",") if s.strip()]  # type: ignore

        return OpenMetadataConfig(
            url=url,  # type: ignore
            email=email,  # type: ignore
            password=password,  # type: ignore
            services=services,
        )
