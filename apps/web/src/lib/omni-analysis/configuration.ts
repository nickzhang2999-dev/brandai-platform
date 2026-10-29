import { getEffectiveAiSettings, type ProviderConfig } from '../settings';
import { falQwenModel, OMNI_FAL_OPENROUTER_BASE, validModelId } from './policy';

/**
 * Omni may select a model on the configured VLM gateway, while credentials,
 * endpoint and all other Nova callers retain the administrator's settings.
 * This server-only override never comes from an analysis request.
 */
export async function getOmniAnalysisProvider(): Promise<ProviderConfig> {
  const effective=await getEffectiveAiSettings();
  const backend=process.env.OMNI_ANALYSIS_PROVIDER || 'vlm';
  const raw=process.env.OMNI_ANALYSIS_MODEL || '';
  const model=raw.trim();
  const valid=validModelId(model)&&!/[\r\n\t]/.test(raw);
  if(backend==='fal-openrouter') {
    // Reuse only the existing fal key. Never inherit the layer endpoint/model or
    // send the platform VLM key to a different provider.
    if(effective.layer?.provider?.toLowerCase()!=='fal'||!effective.layer.apiKey||!valid||!falQwenModel(model))
      return {provider:'fal-openrouter',apiKey:'',baseUrl:OMNI_FAL_OPENROUTER_BASE,model:''};
    return {provider:'fal-openrouter',apiKey:effective.layer.apiKey,baseUrl:OMNI_FAL_OPENROUTER_BASE,model};
  }
  if(backend!=='vlm')return {provider:'',apiKey:'',baseUrl:'',model:''};
  const configured=effective.vlm;
  if(!model)return {...configured};
  // Invalid overrides fail closed rather than silently calling the global model.
  // Valid IDs are still subject to the gateway's model access and capabilities.
  return {...configured,model:valid?model:''};
}
