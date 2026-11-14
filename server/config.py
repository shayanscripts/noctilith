"""Project settings. Override any field with an env var SPHEREX_<FIELD> (upper case)."""
import os
from dataclasses import dataclass, field, fields
from pathlib import Path


@dataclass
class Settings:
    collection: str = "spherex_dr1,spherex_qr3,spherex_dr1_deep,spherex_qr3_deep"  # comma-separated, all searched
    sia_ttl_hours: float = 12.0  # reuse a spot's frame list this long (deep fields are 27 MB to re-query)
    disk_cache: bool = False  # off: nothing saved by an earlier run is reused (SPHEREX_DISK_CACHE=1 to allow)
    browser_cache: bool = False  # off: browsers always fetch fresh pages/images (SPHEREX_BROWSER_CACHE=1 to allow)
    frame_budget: int = 720  # max frames per spot; deep-survey spots are sampled evenly down to this
    cache_dir: Path = field(default_factory=lambda: Path("cache"))
    max_concurrency: int = 12
    pixel_arcsec: float = 6.15
    fov_min: float = 0.02
    fov_max: float = 0.5
    fov_default: float = 0.1
    # where full images are range-read from: "irsa" (IRSA's own /ibe/data/spherex, ~1.5x faster on
    # 2026-11-14) or "aws" (NASA's S3 mirror in us-east-1)
    data_source: str = "irsa"

    def __post_init__(self):
        for f in fields(self):
            env = os.environ.get(f"SPHEREX_{f.name.upper()}")
            if env is not None:
                cur = getattr(self, f.name)
                if isinstance(cur, bool):
                    val = env.strip().lower() in ("1", "true", "yes", "on")
                else:
                    val = Path(env) if isinstance(cur, Path) else type(cur)(env)
                setattr(self, f.name, val)


SETTINGS = Settings()
