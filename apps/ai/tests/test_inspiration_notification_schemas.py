from pydantic import TypeAdapter
from app.schemas import AsyncTaskKind, NotificationKind


def test_inspiration_chat_terminal_event_contract_is_mirrored():
    assert TypeAdapter(AsyncTaskKind).validate_python("INSPIRATION_CHAT") == "INSPIRATION_CHAT"
    assert TypeAdapter(NotificationKind).validate_python("INSPIRATION_CHAT") == "INSPIRATION_CHAT"
