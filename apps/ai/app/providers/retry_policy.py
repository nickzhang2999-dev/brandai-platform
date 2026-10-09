"""Request-local retry policy; never forwarded to prompts or upstream payloads."""
from collections.abc import Awaitable, Callable
from contextvars import ContextVar
from typing import Any, Literal, TypeVar


ProviderRetryPolicy = Literal["never"]
_single_attempt: ContextVar[bool] = ContextVar("provider_single_attempt", default=False)
T = TypeVar("T")


def should_retry_provider(error: BaseException) -> bool:
    # Preserve Tenacity's legacy Exception-only default. In a product request,
    # even a timeout or bad response after a paid POST must not issue it again.
    return isinstance(error, Exception) and not _single_attempt.get()


async def call_with_retry_policy(
    policy: ProviderRetryPolicy | None,
    operation: Callable[..., Awaitable[T]],
    *args: Any,
    **kwargs: Any,
) -> T:
    # Nested calls cannot downgrade an enclosing no-retry scope. ContextVar
    # isolates concurrent legacy/product requests and reset also covers cancel.
    token = _single_attempt.set(_single_attempt.get() or policy == "never")
    try:
        return await operation(*args, **kwargs)
    finally:
        _single_attempt.reset(token)
