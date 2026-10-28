# Studio writing workbench and canvas interaction

The writing workbench provides a conversation beside an editable current draft. Writing tasks produce suggestions; they do not replace the draft until the user accepts a result. The image canvas remains available, and sending a finished draft to the canvas is an explicit action.

## Persistence and task lifecycle

- Documents, immutable versions, messages, references and task access are scoped to the authenticated user, workspace and project. Confirmed brand writing style is shared within the workspace and can be edited by authorized members.
- Document saves use revisions. Selection replacement also validates UTF-16 offsets and the original selected text. Restoring a version creates a new version.
- File parsing, generation and style extraction use durable asynchronous tasks. The worker makes a single provider attempt. An uncertain submission is recovered with its original mutation ID; refreshing a page does not create another model request.
- Images imported from the canvas retain their stored asset identity. Permission and reference removal are checked again during processing and before a result is saved.
- The existing server-side copywriting provider configuration is reused. Provider credentials remain on the server.

## References and style

Supported references are PNG, JPEG, WebP, UTF-8 TXT/Markdown, text-bearing PDF, DOCX and PPTX. The parser does not execute documents, fetch links, render macros or perform OCR. DOCX references use paragraphs rather than inferred printed page numbers.

Limits are 10 MiB per file, 30 references and 64 MiB per document, and 12 references per model request including at most four images. The current draft supports 60,000 UTF-16 code units. Extraction, selected model context and generated output have separate bounded limits. Source coverage and truncation are explicit; upload completion does not imply that the model read an entire document.

Users can save confirmed expression rules and examples. Extracting style from selected examples produces a draft for review; it does not update confirmed style automatically or train a model. Model citations must resolve to source segments actually sent in that request.

## Canvas interaction

The project content panel is collapsed initially and reads the existing canvas and project material records. The conversation panel provides image editing, writing and task history entry points. Basic tools are grouped above the canvas; less frequent image actions and properties remain available through explicit menus.

Clicking a single editable image explicitly chooses the next edit target after its stored identity is checked. Multi-selection, programmatic focus, result arrival and undo restoration do not replace a pending request's target. The composer distinguishes the edit target from reference-only images. Aspect ratio and quality controls remain visible, with a preview of the existing server size-priority rules.

Advanced material settings have one completion action that saves and applies the confirmed revision. A failed read, changed revision or different project prevents stale settings from being applied. Long writing drafts are split into bounded native text objects without altering their text and enter the existing canvas save and undo pipeline as one change.

## Brand kit imports

Brand kit uploads support a bounded multi-file queue and explicit target categories. A chosen category is carried through recognition and enforced when suggestions are saved; differing model classification is retained as reviewable evidence. Multiple suggestions for the same source are grouped for display without deleting individual rules.

Brand kit asset upload identity includes workspace, actor, content and category. Import task mutation IDs recover accepted work rather than resubmitting it. Unknown replies remain recoverable. A definitely rejected item can be removed only after checking that its original task was not accepted. New brand kit tasks recheck actor and source access before provider use and result persistence.

## Verification

Run the repository's required unit, AI, type, lint, build and release checks before publication. Database tests use a separately configured test database. Browser fixture tests cover real components and interactions but do not establish provider quality or production authorization. Authenticated provider acceptance must use owned test materials and report the actual task and deployment result independently.
