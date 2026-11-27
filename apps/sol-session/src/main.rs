use serde_json::{json, Value};
use std::{
    env, fs,
    io::{self, BufRead, BufReader, Read, Write},
    path::PathBuf,
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
};

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
const TOOLS: [&str; 3] = [
    "get_brand_context",
    "get_project_context",
    "get_selected_product",
];

fn scoped_read(scope: &str, facts: &Value, params: &Value) -> Result<Value> {
    if params["sessionId"] != scope || params["args"] != json!({}) {
        return Err("read outside the admitted snapshot".into());
    }
    Ok(match params["name"].as_str() {
        Some("get_selected_product") => {
            json!({"product":facts["product"],"approvedCopy":facts["approvedCopy"]})
        }
        Some("get_brand_context") => json!({"brand":facts["brand"],"rules":facts["rules"]}),
        Some("get_project_context") => {
            json!({"goal":facts["goal"],"audience":facts["audience"],"visualRequirements":facts["visualRequirements"]})
        }
        _ => return Err("unapproved tool".into()),
    })
}

struct Runtime {
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
    scope: String,
    facts: Value,
    calls: Vec<Value>,
    sequence: u64,
    events: Vec<Value>,
    answer: Option<String>,
    terminal: bool,
}
impl Drop for Runtime {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
impl Runtime {
    fn send(&mut self, value: &Value) -> Result<()> {
        serde_json::to_writer(&mut self.input, value)?;
        self.input.write_all(b"\n")?;
        self.input.flush()?;
        Ok(())
    }
    fn read_tool(&mut self, p: &Value) -> Result<Value> {
        if self.calls.len() >= 12 {
            return Err("tool budget exceeded".into());
        }
        let data = scoped_read(&self.scope, &self.facts, p)?;
        self.calls
            .push(json!({"name":p["name"],"source":p["source"].as_str().unwrap_or("agent")}));
        Ok(data)
    }
    fn event(&mut self, p: &Value) -> Result<()> {
        if p["sessionId"] != self.scope {
            return Err("unexpected session".into());
        }
        let e = &p["event"];
        let seq = e["seq"].as_u64().ok_or("event without sequence")?;
        let kind = e["type"].as_str().ok_or("event without type")?;
        if !self.events.is_empty() && seq <= self.sequence {
            return Err("out of order session event".into());
        }
        self.sequence = seq;
        if self.events.len() >= 192 {
            return Err("session event limit".into());
        }
        self.events.push(json!({"seq":seq,"kind":kind}));
        if kind == "assistant/message" {
            let blocks = e.pointer("/data/message/content").and_then(Value::as_array);
            if let Some(blocks) = blocks {
                let text: String = blocks
                    .iter()
                    .filter(|b| b["type"] == "text")
                    .filter_map(|b| b["text"].as_str())
                    .collect();
                if !text.is_empty() {
                    self.answer = Some(text);
                }
            }
        }
        if kind == "turn/end" {
            self.terminal =
                e.pointer("/data/reason/kind").and_then(Value::as_str) == Some("completed");
        }
        Ok(())
    }
    fn rpc(&mut self, id: u32, method: &str, params: Value) -> Result<Value> {
        self.send(&json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}))?;
        loop {
            let mut line = String::new();
            let n = (&mut self.output).take(512 * 1024).read_line(&mut line)?;
            if n == 0 || !line.ends_with('\n') {
                return Err("invalid sidecar frame".into());
            }
            let v: Value = serde_json::from_str(&line)?;
            match v["method"].as_str() {
                Some("sol/read") => {
                    let result = self.read_tool(&v["params"])?;
                    self.send(&json!({"jsonrpc":"2.0","id":v["id"],"result":result}))?;
                }
                Some("session.event") => self.event(&v["params"])?,
                Some("session.status") => {}
                Some(_) => return Err("unrecognized sidecar operation".into()),
                None if v["id"] == id && v.get("result").is_some() => {
                    return Ok(v["result"].clone())
                }
                None => return Err(format!("DSH rejected {method}").into()),
            }
        }
    }
}
fn run() -> Result<Value> {
    let mut line = String::new();
    io::stdin().take(40 * 1024).read_to_string(&mut line)?;
    let v: Value = serde_json::from_str(&line)?;
    let scope = v["sessionId"].as_str().ok_or("session missing")?;
    if scope.len() != 64 || !scope.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("invalid session".into());
    }
    let root = PathBuf::from(env::var("SOL_DSH_HOME")?);
    if !root.is_absolute() {
        return Err("absolute session root required".into());
    }
    let dir = root.join(scope);
    let work = root.join("work");
    fs::create_dir_all(&work)?;
    if v["resume"] == true {
        if !dir.is_dir() {
            return Err("session directory missing".into());
        }
    } else {
        fs::create_dir_all(&root)?;
        fs::create_dir(&dir)?;
    }
    let mut cmd = Command::new(env::var("SOL_DSH_NODE")?);
    cmd.arg(env::var("SOL_DSH_SIDECAR")?)
        .env_clear()
        .current_dir(&work);
    for key in [
        "SYSTEMROOT",
        "WINDIR",
        "SOL_DSH_MODULE_ROOT",
        "SOL_DSH_MODEL_URL",
        "SOL_DSH_MODEL",
    ] {
        if let Ok(value) = env::var(key) {
            cmd.env(key, value);
        }
    }
    cmd.env("HOME", &dir)
        .env("USERPROFILE", &dir)
        .env("DSH_HOME", &dir)
        .env("SOL_LOCAL_INFERENCE_KEY", "local-only");
    let mut child = cmd
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()?;
    let mut rt = Runtime {
        input: child.stdin.take().unwrap(),
        output: BufReader::new(child.stdout.take().unwrap()),
        child,
        scope: scope.into(),
        facts: v["facts"].clone(),
        calls: vec![],
        sequence: 0,
        events: vec![],
        answer: None,
        terminal: false,
    };
    let model = env::var("SOL_DSH_MODEL")?;
    let hello = rt.rpc(
        1,
        "initialize",
        json!({"cwd":work,"model":model,"provider":"sol-pilot","maxTokens":360}),
    )?;
    if hello["serverInfo"]["name"] != "deepseek-harness-sdk-runtime"
        || hello["tools"] != json!(TOOLS)
    {
        return Err("incorrect SDK or tool surface".into());
    }
    let session = json!({"sessionId":scope});
    if v["resume"] == true {
        rt.rpc(2, "session/resume", session.clone())?;
    }
    if !rt.calls.is_empty() {
        return Err("unexpected tool execution during recovery".into());
    }
    if v["readOnly"] == true {
        if v["resume"] != true {
            return Err("recovery requires an existing session".into());
        }
        rt.rpc(5, "shutdown", json!({}))?;
        if !rt.child.wait()?.success() {
            return Err("sidecar shutdown failed".into());
        }
        return Ok(json!({"sessionId":scope,"recoveryToolCalls":0,"events":rt.events}));
    }
    let prompt = v["prompt"].as_str().ok_or("no admitted prompt")?;
    let accepted = rt.rpc(
        3,
        "session/prompt",
        json!({"sessionId":scope,"contentBlocks":[{"type":"text","text":prompt}]}),
    )?;
    rt.rpc(4, "session/wait", session)?;
    rt.rpc(5, "shutdown", json!({}))?;
    if !rt.child.wait()?.success() {
        return Err("sidecar shutdown failed".into());
    }
    if !rt.terminal || rt.answer.is_none() {
        return Err("no completed assistant reply".into());
    }
    Ok(
        json!({"sessionId":scope,"version":hello["version"],"messageId":accepted["messageId"],
        "seq":rt.sequence,"events":rt.events,"reads":rt.calls,"text":rt.answer,"model":model}),
    )
}
fn main() {
    match run() {
        Ok(out) => println!("{out}"),
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(1)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reads_only_admitted_fields_in_current_session() {
        let facts = json!({"brand":"B","product":"P","private":"hidden"});
        for op in TOOLS {
            let value = scoped_read(
                "current",
                &facts,
                &json!({"sessionId":"current","name":op,"args":{}}),
            )
            .unwrap();
            assert!(value.get("private").is_none());
        }
        for (sid, op, args) in [
            ("other", "get_brand_context", json!({})),
            ("current", "get_brand_context", json!({"projectId":"other"})),
            ("current", "generate_image", json!({})),
            ("current", "shell", json!({})),
        ] {
            assert!(scoped_read(
                "current",
                &facts,
                &json!({"sessionId":sid,"name":op,"args":args})
            )
            .is_err());
        }
    }
}
