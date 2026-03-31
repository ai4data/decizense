"""Catalog sync provider (OpenMetadata implementation)."""

from .provider import OpenMetadataSyncProvider

# Alias for the pluggable catalog interface
CatalogSyncProvider = OpenMetadataSyncProvider

__all__ = ["CatalogSyncProvider", "OpenMetadataSyncProvider"]
