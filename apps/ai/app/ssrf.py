"""SSRF helpers for the AI service's server-side image fetches.

`_inline_image()` legitimately fetches *internal* storage URLs (that's its
purpose), so we do NOT block the initial URL. The attack surface is redirects:
an editor-saved WEBSITE asset whose public URL 30x-redirects to an internal
image / cloud-metadata endpoint. We follow redirects manually and refuse to
follow a hop whose host is (or resolves to) a private / loopback / link-local
address.
"""

import ipaddress
import socket


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
