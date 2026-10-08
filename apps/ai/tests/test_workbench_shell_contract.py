import pytest
from pydantic import ValidationError
from app.schemas import (
    WorkbenchArchiveInput, WorkbenchBrandDraft, WorkbenchContextSaveInput,
    WorkbenchDraftSaveInput, WorkbenchProfile, WorkbenchProjectCreateInput,
    WorkbenchShellSaveInput, WorkbenchShellState,
)


PROFILE = {"nickname": "真实用户", "density": "comfortable", "motion": "system"}
BRAND = {"name": "品牌", "colors": ["#7C5CFF", "#171717", "#F4F0FF"], "font": "system", "notes": "尚未确认的品牌草稿"}
STATE = {"revision": 0, "profile": PROFILE, "brand": BRAND, "favorites": ["project_1"]}
REQUEST_ID = "ea98d4b7-4898-477f-b1a3-487427b6b14a"


def test_shell_preserves_chinese_and_explicit_empty_drafts():
    assert WorkbenchShellState(**STATE).model_dump() == STATE
    created = WorkbenchProjectCreateInput(projectName="  新项目  ", brief="中文\n需求", requestId=REQUEST_ID)
    assert created.model_dump() == {"projectName": "新项目", "brief": "中文\n需求", "requestId": REQUEST_ID}
    assert WorkbenchDraftSaveInput(projectId="p", revision=2147483646, inputForm=None).inputForm is None
    assert len(WorkbenchContextSaveInput(projectId="p", revision=0, brief="文" * 6000, notes="注" * 4000).notes) == 4000
    assert WorkbenchBrandDraft(**{**BRAND, "name": "  品牌  "}).name == "品牌"


@pytest.mark.parametrize("group", ["profile", "brand", "favorites"])
def test_shell_explicit_save_group(group):
    assert WorkbenchShellSaveInput(**STATE, group=group).group == group


@pytest.mark.parametrize("group", [None, "all", "", 1])
def test_shell_rejects_ambiguous_save_group(group):
    with pytest.raises(ValidationError):
        WorkbenchShellSaveInput(**STATE, group=group)


@pytest.mark.parametrize("revision", [-1, 0.5, 2147483647, "1", True, None])
def test_shell_revision_cannot_coerce_or_overflow(revision):
    for schema, value in [
        (WorkbenchShellSaveInput, {**STATE, "group": "profile", "revision": revision}),
        (WorkbenchContextSaveInput, {"projectId": "p", "revision": revision, "brief": "", "notes": ""}),
        (WorkbenchArchiveInput, {"projectId": "p", "revision": revision, "archived": True, "projectVersion": "novart-0"}),
        (WorkbenchDraftSaveInput, {"projectId": "p", "revision": revision, "inputForm": None}),
    ]:
        with pytest.raises(ValidationError):
            schema(**value)


@pytest.mark.parametrize("patch", [
    {"name": " "}, {"name": "b" * 61}, {"colors": ["#ffffff"]},
    {"colors": ["#ffffff", "#000000", "#abc"]}, {"colors": ["#ffffff", "#000000", "red"]},
    {"colors": ["#ffffff", "#000000", "#abcdef\n"]},
    {"font": "remote-font"}, {"notes": "n" * 2001}, {"verified": True},
])
def test_shell_rejects_malformed_brand(patch):
    with pytest.raises(ValidationError):
        WorkbenchBrandDraft(**{**BRAND, **patch})


def test_shell_rejects_unknown_fields_foreign_paths_and_missing_request_id():
    for schema, value in [
        (WorkbenchShellSaveInput, {**STATE, "group": "profile", "workspaceId": "other"}),
        (WorkbenchShellSaveInput, STATE),
        (WorkbenchShellState, {**STATE, "favorites": ["../foreign"]}),
        (WorkbenchShellState, {**STATE, "favorites": ["p"] * 101}),
        (WorkbenchProfile, {**PROFILE, "role": "OWNER"}),
        (WorkbenchProjectCreateInput, {"projectName": "p", "brief": ""}),
        (WorkbenchProjectCreateInput, {"projectName": "p", "brief": "x" * 6001, "requestId": REQUEST_ID}),
    ]:
        with pytest.raises(ValidationError):
            schema(**value)
    for value in [None, "", "1234", REQUEST_ID + "\n"]:
        with pytest.raises(ValidationError):
            WorkbenchProjectCreateInput(projectName="p", brief="", requestId=value)


@pytest.mark.parametrize("project_version", ["local-1", "novart-01", "novart--1", "novart-2147483647", "novart-1\n"])
def test_shell_archive_requires_native_revision(project_version):
    with pytest.raises(ValidationError):
        WorkbenchArchiveInput(projectId="p", revision=0, archived=True, projectVersion=project_version)


def test_shell_requires_boolean_archive_and_explicit_draft_object_or_null():
    for value in ["true", 1, None]:
        with pytest.raises(ValidationError):
            WorkbenchArchiveInput(projectId="p", revision=0, archived=value, projectVersion="novart-0")
    for value in [[], "draft", 1]:
        with pytest.raises(ValidationError):
            WorkbenchDraftSaveInput(projectId="p", revision=0, inputForm=value)
    with pytest.raises(ValidationError):
        WorkbenchDraftSaveInput(projectId="p", revision=0)
    draft = WorkbenchDraftSaveInput(projectId="p", revision=0, inputForm={"prompt": "中文", "resolution": "2K", "ratio": "1:1"})
    assert draft.inputForm["prompt"] == "中文"
