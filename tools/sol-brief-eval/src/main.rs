use async_openai::{config::OpenAIConfig, types::*, Client};
use rig::{completion::CompletionModel, message::AssistantContent, prelude::*, providers::openai};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{env, error::Error, time::Duration};

type Failure = Box<dyn Error>;
const SKILL: &str = include_str!("../brand-poster-skill.md");
const REQUEST: &str =
    "给当前商品做三张推广海报，分别突出外观、使用场景和核心卖点。未确认的宣传说法先列出来。";

#[derive(Deserialize, Serialize)]
struct Product {
    revision: u32,
    workspace: String,
    project: String,
    sku: String,
    product: String,
    brand: String,
    mark: String,
    color: String,
    typeface: String,
    keep: Vec<String>,
    copy: String,
    unconfirmed: String,
    settings: Vec<String>,
}

fn selected(workspace: &str, project: &str, sku: &str) -> Result<Product, Failure> {
    // Offline fixture catalogue only. Live product reads require the Studio membership guard.
    for raw in [
        include_str!("../fixtures/AT-01.json"),
        include_str!("../fixtures/ST-02.json"),
    ] {
        let p: Product = serde_json::from_str(raw)?;
        if p.workspace == workspace && p.project == project && p.sku == sku {
            return Ok(p);
        }
    }
    Err("Selection does not belong to this fixture scope".into())
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Choices {
    sku: String,
    appearance: String,
    scene: String,
    detail: String,
}
fn validate(p: &Product, raw: &str) -> Result<Choices, Failure> {
    let c: Choices = serde_json::from_str(raw)?;
    if c.sku != p.sku
        || !p.settings.contains(&c.scene)
        || !["正面主视", "轮廓留白"].contains(&c.appearance.as_str())
        || !["局部放大", "引线标注"].contains(&c.detail.as_str())
    {
        return Err("Brief conflicts with the selected product or its approved claims".into());
    }
    Ok(c)
}

async fn ask(adapter: &str, url: &str, model: &str, prompt: &str) -> Result<String, Failure> {
    match adapter {
        "rig" => {
            let reply = openai::Client::from_url("local-only", url)
                .completion_model(model)
                .completion_request(prompt)
                .preamble(SKILL.to_owned())
                .temperature(0.2)
                // This pinned OpenAI adapter serializes extra parameters but omits the builder token limit.
                .additional_params(
                    json!({"max_tokens":320,"response_format":{"type":"json_object"}}),
                )
                .send()
                .await?;
            if reply.raw_response.choices.len() != 1
                || reply.raw_response.choices[0].finish_reason != "stop"
            {
                return Err("Brief did not finish with a single text result".into());
            }
            match (reply.choice.len(), reply.choice.first()) {
                (1, AssistantContent::Text(value)) => Ok(value.text),
                _ => Err("Expected a single brief without tool calls".into()),
            }
        }
        "async-openai" => {
            let config = OpenAIConfig::new()
                .with_api_base(url)
                .with_api_key("local-only");
            let req = CreateChatCompletionRequestArgs::default()
                .model(model)
                .temperature(0.2)
                .max_tokens(320u32)
                .response_format(ResponseFormat::JsonObject)
                .messages(vec![
                    ChatCompletionRequestSystemMessageArgs::default()
                        .content(SKILL)
                        .build()?
                        .into(),
                    ChatCompletionRequestUserMessageArgs::default()
                        .content(prompt)
                        .build()?
                        .into(),
                ])
                .build()?;
            // A failed read is recorded for this comparison. Never replay an ambiguous POST.
            let retry = backoff::ExponentialBackoffBuilder::new()
                .with_max_elapsed_time(Some(Duration::ZERO))
                .build();
            let reply = Client::with_config(config)
                .with_backoff(retry)
                .chat()
                .create(req)
                .await?;
            let [choice] = reply.choices.as_slice() else {
                return Err("Expected one choice".into());
            };
            if choice.finish_reason != Some(FinishReason::Stop) {
                return Err("Brief did not finish with a single text result".into());
            }
            let msg = &choice.message;
            if msg.tool_calls.is_some() {
                return Err("Tool calls disabled during briefing".into());
            }
            Ok(msg.content.clone().ok_or("No brief text")?)
        }
        _ => Err("Use rig or async-openai".into()),
    }
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Failure> {
    let args: Vec<_> = env::args().skip(1).collect();
    let [adapter, port, model, workspace, project, sku] = args.as_slice() else {
        return Err(
            "usage: sol-brief-eval ADAPTER LOOPBACK_PORT MODEL WORKSPACE PROJECT SKU".into(),
        );
    };
    let p = selected(workspace, project, sku)?;
    let url = format!("http://127.0.0.1:{}/v1", port.parse::<u16>()?);
    let prompt = serde_json::to_string(&json!({"request":REQUEST,"selection":p}))?;
    let timeout = match env::var("SOL_BRIEF_LOCAL_TIMEOUT_MS") {
        Ok(ms) => Duration::from_millis(ms.parse::<u64>()?.clamp(1, 90_000)),
        Err(_) => Duration::from_secs(90),
    };
    let raw = if adapter == "render-baseline" {
        std::io::read_to_string(std::io::stdin())?
    } else {
        tokio::time::timeout(timeout, ask(adapter, &url, model, &prompt)).await??
    };
    let c = validate(&p, &raw)?;
    println!(
        "{}",
        serde_json::to_string_pretty(&json!({"skill":"brand-poster/v1","workspace":workspace,
        "project":project,"sku":sku,"source_revision":p.revision,"product":p.product,"brand":p.brand,"logo":p.mark,"color":p.color,
        "typeface":p.typeface,"protected":p.keep,"posters":[
        {"purpose":"外观","layout":c.appearance},{"purpose":"使用场景","setting":c.scene},
        {"purpose":"已确认卖点","layout":c.detail,"copy":p.copy}],"needs_confirmation":[p.unconfirmed]}))?
    );
    Ok(())
}
