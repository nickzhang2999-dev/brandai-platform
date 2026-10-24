import pytest
from pydantic import ValidationError
from app.omni_analysis_schemas import OmniAnalysisInput, OmniAnalysisJob, OmniAnalysisResult


def test_input_is_service_data_not_provider_configuration():
    body = dict(request_id='0123456789abcdef', source_image_id='image-1', revision=1,
                image_sha256='a' * 64, image_base64='/9j/AA==', title='', description='')
    assert OmniAnalysisInput(**body).revision == 1
    for change in ({'revision': True}, {'revision': 0}, {'api_key': 'never allowed'}, {'image_url': 'https://example.test/a.jpg'}):
        with pytest.raises(ValidationError):
            OmniAnalysisInput(**(body | change))


def test_analysis_has_eight_design_fields_without_authorization_or_review():
    body = dict(kind='reference', purposes=[], reason='图像观察', description='', ocr_text='', brand='',
                design={k: '' for k in ['palette', 'typography', 'composition', 'hierarchy', 'imagery', 'reusable_ideas', 'applicability', 'limitations']},
                model_version='configured-model')
    assert OmniAnalysisResult(**body).model_version == 'configured-model'
    for change in ({'purposes': ['brand', 'brand']}, {'permissions': {'analysis': 'allowed'}}, {'review_status': 'accepted'}, {'model_version': ''}, {'model_version': ' '}, {'model_version': 'm' * 201}, {'reason': ''}, {'reason': '  '}, {'kind': 'advertisement', 'purposes': []}):
        with pytest.raises(ValidationError):
            OmniAnalysisResult(**(body | change))


def test_job_omits_result_until_completed():
    assert OmniAnalysisJob(id='job', status='queued', reason='').model_dump(exclude_none=True) == dict(id='job', status='queued', reason='')
    with pytest.raises(ValidationError):
        OmniAnalysisJob(id='job', status='queued', reason='', result=None)
