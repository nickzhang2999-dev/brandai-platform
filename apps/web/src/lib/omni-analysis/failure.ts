/** Safe, finite diagnostics. Never include provider text, URLs, headers or values. */
type FailureCode = 'invalid_jpeg' | 'visual_model_not_configured' | 'provider_request_failed'
  | 'provider_http_error' | 'provider_response_too_large' | 'provider_response_read_failed'
  | 'provider_response_json_invalid' | 'provider_output_truncated' | 'provider_content_filtered'
  | 'provider_content_missing' | 'provider_output_json_invalid' | 'provider_schema_invalid';
const FIELDS=new Set(['kind','purposes','reason','description','ocr_text','brand','design','palette',
  'typography','composition','hierarchy','imagery','reusable_ideas','applicability','limitations','model_version']);
export class AnalysisFailure extends Error {
  constructor(public readonly code:FailureCode,public readonly status?:number,public readonly paths?:Array<Array<string|number>>) {super(code);}
  safeReason() {
    const status=this.status;
    if(this.code==='provider_http_error')return typeof status==='number'&&Number.isInteger(status)&&status>=100&&status<=599?`provider_http_${status}`:'provider_http_error';
    if(this.code==='provider_schema_invalid') {
      const paths=[...new Set((this.paths || []).slice(0,6).map(path=>
        path.length&&path.every(part=>typeof part==='number'?Number.isSafeInteger(part)&&part>=0&&part<=100: FIELDS.has(part))?path.join('.'):'root'))];
      return paths.length?`provider_schema_invalid:${paths.join(',')}`:this.code;
    }
    return this.code;
  }
}
export function safeAnalysisFailure(error:unknown,aborted=false) {
  if(aborted)return 'analysis_timeout';
  return error instanceof AnalysisFailure?error.safeReason():'analysis_failed';
}
