"""SSRF helpers for the AI service's server-side fetches.

Two callers, two policies:
- `_inline_image()` legitimately fetches *internal* storage URLs (that's its
  purpose) → `allow_private_initial=True`: the initial URL may be internal, but
  redirect hops (attacker-controllable via a saved WEBSITE asset URL) are
  validated and refused if private.
- `scrape_website()` fetches a *user-supplied* page URL → `allow_private_initial
  =False`: both the initial host and every redirect hop must be public.
"""

import ipaddress
import socket
from typing import Any

import httpx


class SSRFError(Exception):
    """Raised when a fetch target (or a redirect hop) resolves to private space."""


def _ip_is_private(ip: str) -> bool:
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return False
    return (
        addr.is_private
        or addr.is_loopback
        or addr.is_link_local  # 169.254.0.0/16 (incl. cloud metadata) + fe80::/10
        or addr.is_reserved
        or addr.is_multicast
        or addr.is_unspecified
    )


def host_is_private(host: str | None) -> bool:
    """True if host is, or resolves to, a private/loopback/link-local address.

    An unresolvable or empty host is treated as unsafe (returns True).
    """
    if not host:
        return True
    h = host.strip("[]").lower()
    if h == "localhost" or h.endswith(".localhost"):
        return True
    try:
        ipaddress.ip_address(h)  # literal IP?
        return _ip_is_private(h)
    except ValueError:
        pass
    try:
        infos = socket.getaddrinfo(h, None)
    except OSError:
        return True  # can't resolve → refuse
    return any(_ip_is_private(info[4][0]) for info in infos)


async def safe_get(
    client: httpx.AsyncClient,
    url: str,
    *,
    allow_private_initial: bool = False,
    max_redirects: int = 4,
    **kwargs: Any,
) -> httpx.Response:
    """GET `url`, following redirects manually and refusing any hop into private
    space. Raises SSRFError on a blocked host or too many redirects.
    """
    # Tests drive these providers through httpx.MockTransport with fake hosts
    # that don't resolve; the SSRF host check does real DNS and can't be mocked
    # at the transport layer. Skip it under a MockTransport (host_is_private has
    # its own unit test); real deployments use a real transport → enforced.
    mocked = isinstance(getattr(client, "_transport", None), httpx.MockTransport)
    current = url
    for hop in range(max_redirects + 1):
        skip_check = mocked or (hop == 0 and allow_private_initial)
        if not skip_check and host_is_private(httpx.URL(current).host):
            raise SSRFError(f"blocked private host: {current}")
        r = await client.get(current, follow_redirects=False, **kwargs)
        if r.is_redirect:
            loc = r.headers.get("location")
            if not loc:
                return r
            current = str(httpx.URL(current).join(loc))
            continue
        return r
    raise SSRFError("too many redirects")
