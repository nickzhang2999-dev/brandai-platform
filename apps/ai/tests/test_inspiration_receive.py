import pytest
from pydantic import ValidationError
from app.inspiration_schemas import InspirationReceiveStatus


def receipt():
    return dict(enabled=True, configured=True, mode='manual', canReceive=True, task=dict(
        id='task', status='RUNNING', error=None, createdAt='2026-11-02T06:00:00Z',
        updatedAt='2026-11-02T06:00:01Z', expiresAt='2026-11-02T06:06:00Z'))


def test_receive_state_preserves_nullable_task_and_legacy_expiry():
    assert InspirationReceiveStatus(**receipt()).task.status == 'RUNNING'
    value = receipt()
    value['task']['expiresAt'] = None
    assert InspirationReceiveStatus(**value).task.expiresAt is None
    value['task'] = None
    assert InspirationReceiveStatus(**value).task is None


@pytest.mark.parametrize('field,value', [('mode', 'bad'), ('task', {}), ('task', {'status': 'UNKNOWN'})])
def test_invalid_receive_contract(field, value):
    with pytest.raises(ValidationError):
        InspirationReceiveStatus(**{**receipt(), field: value})


@pytest.mark.parametrize('value', ['yesterday', '2026-02-30T06:00:00Z', '2026-11-02T06:00:00+08:00', None])
def test_required_task_timestamps_are_valid_utc(value):
    data = receipt()
    data['task']['createdAt'] = value
    with pytest.raises(ValidationError):
        InspirationReceiveStatus(**data)
