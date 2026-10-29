import pytest
from pydantic import ValidationError
from app.inspiration_schemas import InspirationListResponse, InspirationSyncStatus


def channel(state='unknown'):
    return dict(state=state, lastAttemptAt=None, lastSuccessAt=None, lastFailureAt=None, error=None)


def status():
    return dict(content=channel(), withdrawals=channel(), activeManifestHash=None, withdrawalHash=None)


def legacy_list():
    return dict(enabled=True, syncConfigured=True, activeRelease=None, caseCount=0,
                withdrawalSequence=0, lastSyncAt=None, error=None, cases=[], searchMode='keyword-tags')


def test_legacy_list_omits_new_status_but_explicit_null_is_not_a_status():
    assert InspirationListResponse(**legacy_list()).syncStatus is None
    with pytest.raises(ValidationError):
        InspirationListResponse(**legacy_list(), syncStatus=None)


def test_status_preserves_nullable_observations_and_accepts_valid_hashes():
    value=status()
    value['activeManifestHash']='a' * 64
    value['content']['lastSuccessAt']='2026-10-26T05:00:00.000Z'
    result=InspirationListResponse(**legacy_list(), syncStatus=value)
    assert result.syncStatus.content.lastSuccessAt == '2026-10-26T05:00:00.000Z'
    assert result.syncStatus.withdrawals.lastSuccessAt is None


@pytest.mark.parametrize('bad', ['token-instead-of-hash', '', 'A' * 64])
def test_rejects_unverifiable_hashes(bad):
    with pytest.raises(ValidationError):
        InspirationSyncStatus(**{**status(), 'withdrawalHash': bad})


@pytest.mark.parametrize('bad', ['yesterday', '2026-10-26', '2026-02-30T05:00:00Z', '2026-10-26T05:00:00+08:00'])
def test_rejects_non_utc_or_invalid_observation_times(bad):
    value=status()
    value['content']['lastAttemptAt']=bad
    with pytest.raises(ValidationError):
        InspirationSyncStatus(**value)


def test_channel_state_is_not_an_unbounded_provider_error():
    value=status()
    value['withdrawals']['state']='private-upstream-error'
    with pytest.raises(ValidationError):
        InspirationSyncStatus(**value)
