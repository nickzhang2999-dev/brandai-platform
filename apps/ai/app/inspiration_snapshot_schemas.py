"""Strict additive mirror of contracts/inspiration-snapshot.ts; no AI endpoint."""
from datetime import datetime
from typing import Annotated, Any, Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator, model_validator

Id = Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\z")]
Hash = Annotated[str, StringConstraints(min_length=64, max_length=64, pattern=r"^[a-f0-9]+\z")]
Prefix = Annotated[str, StringConstraints(min_length=2, max_length=8, pattern=r"^[a-f0-9]+\z")]
SafeInteger = Annotated[int, Field(ge=0, le=9007199254740991)]
Positive = Annotated[int, Field(ge=1, le=9007199254740991)]


class SnapshotStrict(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    @model_validator(mode="before")
    @classmethod
    def strict_version(cls, value):
        if isinstance(value, dict) and "schema_version" in value and type(value["schema_version"]) is not int:
            raise ValueError("Version must be an integer")
        return value


class InspirationSnapshotRecipient(SnapshotStrict):
    kind: Literal["library"]
    origin: str
    library_id: Id

    @field_validator("origin")
    @classmethod
    def exact_https_origin(cls, value):
        parsed = urlsplit(value)
        if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment:
            raise ValueError("Exact HTTPS origin required")
        host = parsed.hostname.encode("idna").decode("ascii")
        if ":" in host:
            host = "[" + host + "]"
        port = parsed.port
        normalized = "https://" + host + (f":{port}" if port is not None and port != 443 else "")
        if value != normalized:
            raise ValueError("Exact HTTPS origin required")
        return value


class InspirationSnapshotPartDescriptor(SnapshotStrict):
    prefix: Prefix
    sha256: Hash
    size: int = Field(ge=1, le=8 * 1024 * 1024)
    records_count: int = Field(ge=1, le=2000)


class InspirationSnapshotObjectDescriptor(SnapshotStrict):
    path: str = Field(max_length=80, pattern=r"^images/[a-f0-9]{64}\.(png|jpg|jpeg|webp)\z")
    sha256: Hash
    size: int = Field(ge=1, le=20 * 1024 * 1024)
    mime: Literal["image/png", "image/jpeg", "image/webp"]
    width: int = Field(ge=1, le=40_000_000)
    height: int = Field(ge=1, le=40_000_000)

    @model_validator(mode="after")
    def content_binding(self):
        if self.width * self.height > 40_000_000:
            raise ValueError("Image pixel limit")
        if not self.path.startswith("images/" + self.sha256 + "."):
            raise ValueError("Object path checksum mismatch")
        extension = self.path.rsplit(".", 1)[1]
        mime = {"png": "image/png", "webp": "image/webp", "jpg": "image/jpeg", "jpeg": "image/jpeg"}[extension]
        if self.mime != mime:
            raise ValueError("Object path format mismatch")
        return self


class InspirationSnapshotRecord(SnapshotStrict):
    op: Literal["upsert"]
    case_id: Id
    revision: Positive
    content_hash: Hash
    case: dict[str, Any]


class InspirationSnapshotPart(SnapshotStrict):
    schema_version: Literal[3]
    prefix: Prefix
    records: list[InspirationSnapshotRecord] = Field(min_length=1, max_length=2000)
    objects: list[InspirationSnapshotObjectDescriptor] = Field(min_length=1, max_length=1_000_000)


class InspirationSnapshotManifest(SnapshotStrict):
    schema_version: Literal[3]
    kind: Literal["snapshot"]
    recipient: InspirationSnapshotRecipient
    release_id: Id
    sequence: Positive
    parent_release_id: Id | None
    created_at: str = Field(pattern=r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]+)?)?Z\z")
    taxonomy_version: str = Field(min_length=1, max_length=50_000)
    request_hash: Hash
    records_count: int = Field(ge=0, le=100_000)
    image_count: int = Field(ge=0, le=1_000_000)
    image_bytes: int = Field(ge=0, le=100 * 1024 * 1024 * 1024)
    withdrawal_sequence: SafeInteger
    parts: list[InspirationSnapshotPartDescriptor] = Field(max_length=4096)
    key_id: Id
    signature: str = Field(min_length=88, max_length=88, pattern=r"^[A-Za-z0-9+/]{86}==\z")

    @field_validator("created_at")
    @classmethod
    def valid_timestamp(cls, value):
        # Zod's Gregorian date validator accepts year 0000 and optional seconds.
        # Python datetime starts at year 1; year 0400 has the same leap semantics.
        checked = "0400" + value[4:] if value.startswith("0000-") else value
        datetime.fromisoformat(checked[:-1] + "+00:00")
        return value

    @field_validator("taxonomy_version")
    @classmethod
    def nonblank_text(cls, value):
        if not value.strip():
            raise ValueError("Nonblank text required")
        return value
