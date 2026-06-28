use anyhow::{anyhow, bail, Context, Result};
use clap::{Parser, ValueEnum};
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::env;
use std::fs;
use std::fs::OpenOptions;
use std::io::Read;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const SYSTEM_PROMPT: &str = r#"You are the headless executor for an autonomous cloud coding agent.

You are running inside an isolated repository worktree. There is no human UI and no command approval prompt.
Work autonomously until the mission is complete, blocked, or failed.

Critical operating rules:
- Follow the mission exactly and stay scoped to the assigned issue or PR.
- Do not reveal, print, copy, or exfiltrate secrets, tokens, environment variables, credentials, or API keys.
- Prefer small, focused changes. Do not refactor unrelated code.
- Use repository tools and GitHub CLI when needed. The shell already has GitHub auth configured.
- For issue implementation tasks, create the requested branch/commit/PR or post the requested GitHub comment/close the issue.
- For PR tasks, modify the PR branch if needed and post a concise PR comment.
- For review tasks, write /tmp/review-findings.json exactly as the mission requests before finishing.
- Before finishing implementation work, write /tmp/criteria-check.json and /tmp/decision-log.json if the mission asks for them.

You must respond with exactly one JSON object and no markdown. The JSON object must have this shape:
{
  "note": "one short progress note about the next step",
  "action": { "type": "..." }
}

Available actions:

1. Read a text file:
{ "type": "read_file", "path": "src/file.ts", "start_line": 1, "max_lines": 200 }

2. Write a complete text file:
{ "type": "write_file", "path": "src/file.ts", "content": "full file contents" }

3. Replace one exact text span in a file. The old text must appear exactly once:
{ "type": "replace_in_file", "path": "src/file.ts", "old": "exact old text", "new": "replacement text" }

4. Append text to a file:
{ "type": "append_file", "path": "/tmp/decision-log.json", "content": "..." }

5. Search with ripgrep:
{ "type": "search", "pattern": "deleteResource", "path": ".", "max_matches": 80 }

6. List files recursively:
{ "type": "list_files", "path": ".", "max_entries": 300 }

7. Run a shell command:
{ "type": "shell", "command": "npm test", "timeout_seconds": 120 }

8. Inspect git diff:
{ "type": "git_diff", "max_chars": 20000 }

9. Finish:
{ "type": "finish", "status": "succeeded", "summary": "what changed and how it was verified" }
{ "type": "finish", "status": "waiting", "summary": "what question was posted and why" }
{ "type": "finish", "status": "failed", "summary": "why the task cannot be completed" }

After each tool result, choose the next action. Do not finish until the mission's required observable outputs exist.
"#;

#[derive(Parser, Debug)]
#[command(name = "agent-executor")]
#[command(about = "Headless cloud executor for GitHub agent tasks")]
struct Cli {
    #[arg(long)]
    mission_file: PathBuf,

    #[arg(long)]
    model: String,

    #[arg(long, value_enum, default_value_t = ExecutorMode::Task)]
    mode: ExecutorMode,

    #[arg(long, default_value = "/tmp/executor-result.json")]
    result_file: PathBuf,

    #[arg(long, env = "EXECUTOR_MAX_TURNS", default_value_t = 80)]
    max_turns: usize,

    #[arg(long, env = "EXECUTOR_MAX_TOOL_OUTPUT_CHARS", default_value_t = 12000)]
    max_tool_output_chars: usize,

    #[arg(
        long,
        env = "OPENROUTER_BASE_URL",
        default_value = "https://openrouter.ai/api/v1"
    )]
    base_url: String,

    /// Local repository path to operate in. Defaults to current working directory.
    #[arg(long)]
    repo: Option<PathBuf>,

    /// Optional JSONL trace file path. Parent directories are created if needed.
    #[arg(long)]
    trace_file: Option<PathBuf>,
}

#[derive(Copy, Clone, Debug, ValueEnum)]
enum ExecutorMode {
    Task,
    Review,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct ChatMessage {
    role: String,
    content: String,
}

#[derive(Debug, Deserialize)]
struct ActionEnvelope {
    #[serde(alias = "thought")]
    note: Option<String>,
    action: Action,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Action {
    ReadFile {
        path: String,
        start_line: Option<usize>,
        max_lines: Option<usize>,
    },
    WriteFile {
        path: String,
        content: String,
    },
    ReplaceInFile {
        path: String,
        old: String,
        new: String,
    },
    AppendFile {
        path: String,
        content: String,
    },
    Search {
        pattern: String,
        path: Option<String>,
        max_matches: Option<usize>,
    },
    ListFiles {
        path: Option<String>,
        max_entries: Option<usize>,
    },
    Shell {
        command: String,
        timeout_seconds: Option<u64>,
    },
    GitDiff {
        max_chars: Option<usize>,
    },
    Finish {
        status: FinishStatus,
        summary: String,
    },
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum FinishStatus {
    Succeeded,
    Waiting,
    Failed,
}

#[derive(Debug, Serialize)]
struct ToolResult {
    ok: bool,
    output: String,
    truncated: bool,
}

#[derive(Debug)]
struct ProcessOutput {
    code: Option<i32>,
    stdout: String,
    stderr: String,
    timed_out: bool,
}

struct Executor {
    client: Client,
    api_key: String,
    base_url: String,
    model: String,
    cwd: PathBuf,
    max_tool_output_chars: usize,
}

struct TraceWriter {
    file: Option<fs::File>,
}

impl TraceWriter {
    fn none() -> Self {
        TraceWriter { file: None }
    }

    fn open(path: &Path, repo: &Path) -> Result<Self> {
        let candidate = if path.is_absolute() {
            path.to_path_buf()
        } else {
            repo.join(path)
        };

        let parent = candidate
            .parent()
            .ok_or_else(|| anyhow!("trace path has no parent: {}", candidate.display()))?;
        let canonical_parent = nearest_existing_ancestor(parent)?;

        if !is_allowed_trace_path(&canonical_parent, repo) {
            bail!(
                "trace path outside repository and /tmp is not allowed: {}",
                candidate.display()
            );
        }

        if let Some(parent) = candidate.parent() {
            fs::create_dir_all(parent).with_context(|| {
                format!("failed to create trace directory {}", parent.display())
            })?;
        }

        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&candidate)
            .with_context(|| format!("failed to open trace file {}", candidate.display()))?;

        Ok(TraceWriter { file: Some(file) })
    }

    fn write_event(&mut self, event: Value) {
        if let Some(file) = &mut self.file {
            let mut line = serde_json::to_string(&event).unwrap_or_else(|_| "{}".to_string());
            line.push('\n');
            let _ = file.write_all(line.as_bytes());
            let _ = file.flush();
        }
    }

    fn run_start(
        &mut self,
        model: &str,
        mode: &str,
        repo: &Path,
        mission_file: &Path,
        max_turns: usize,
    ) {
        self.write_event(json!({
            "event": "run_start",
            "model": model,
            "mode": mode,
            "repo": repo.display().to_string(),
            "mission_file": mission_file.display().to_string(),
            "max_turns": max_turns,
            "unix_timestamp": unix_now(),
        }));
    }

    fn turn_start(&mut self, turn: usize, max_turns: usize) {
        self.write_event(json!({
            "event": "turn_start",
            "turn": turn,
            "max_turns": max_turns,
        }));
    }

    fn model_response(&mut self, turn: usize, content: &str, elapsed_ms: u128) {
        self.write_event(json!({
            "event": "model_response",
            "turn": turn,
            "content": redact_secrets(content),
            "elapsed_ms": elapsed_ms,
        }));
    }

    fn protocol_error(&mut self, turn: usize, error: &str) {
        self.write_event(json!({
            "event": "protocol_error",
            "turn": turn,
            "error": redact_secrets(error),
        }));
    }

    fn parsed_action(&mut self, turn: usize, note: Option<&str>, action_type: &str) {
        self.write_event(json!({
            "event": "parsed_action",
            "turn": turn,
            "note": redact_secrets(note.unwrap_or("")),
            "action_type": action_type,
        }));
    }

    fn tool_result(
        &mut self,
        turn: usize,
        ok: bool,
        truncated: bool,
        output: &str,
        elapsed_ms: u128,
    ) {
        self.write_event(json!({
            "event": "tool_result",
            "turn": turn,
            "ok": ok,
            "truncated": truncated,
            "output": redact_secrets(output),
            "elapsed_ms": elapsed_ms,
        }));
    }

    fn finish(&mut self, turn: usize, status: &str, summary: &str) {
        self.write_event(json!({
            "event": "finish",
            "turn": turn,
            "status": status,
            "summary": redact_secrets(summary),
        }));
    }

    fn run_failed(&mut self, summary: &str) {
        self.write_event(json!({
            "event": "run_failed",
            "summary": redact_secrets(summary),
        }));
    }
}

fn main() {
    if let Err(error) = run() {
        eprintln!("executor error: {error:#}");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let cli = Cli::parse();
    let mission = fs::read_to_string(&cli.mission_file)
        .with_context(|| format!("failed to read mission file {}", cli.mission_file.display()))?;
    let api_key = env::var("OPENROUTER_API_KEY").context("OPENROUTER_API_KEY is required")?;

    let cwd = resolve_repo_cwd(cli.repo.as_deref())?;

    let mut trace = match &cli.trace_file {
        Some(trace_path) => TraceWriter::open(trace_path, &cwd)?,
        None => TraceWriter::none(),
    };

    let mode_str = match cli.mode {
        ExecutorMode::Task => "task",
        ExecutorMode::Review => "review",
    };
    trace.run_start(&cli.model, mode_str, &cwd, &cli.mission_file, cli.max_turns);

    let client = Client::builder()
        .timeout(Duration::from_secs(env_u64(
            "EXECUTOR_HTTP_TIMEOUT_SECONDS",
            240,
        )))
        .build()
        .context("failed to create HTTP client")?;

    let executor = Executor {
        client,
        api_key,
        base_url: cli.base_url.trim_end_matches('/').to_string(),
        model: cli.model,
        cwd,
        max_tool_output_chars: cli.max_tool_output_chars,
    };

    let mode_note = match cli.mode {
        ExecutorMode::Task => "Mode: implementation/planning/diagnostic task.",
        ExecutorMode::Review => {
            "Mode: review task. You must write /tmp/review-findings.json before finishing."
        }
    };

    let mut messages = vec![
        ChatMessage {
            role: "system".to_string(),
            content: SYSTEM_PROMPT.to_string(),
        },
        ChatMessage {
            role: "user".to_string(),
            content: format!("{mode_note}\n\nMISSION:\n{mission}"),
        },
    ];

    for turn in 1..=cli.max_turns {
        println!("=== executor turn {turn}/{} ===", cli.max_turns);
        trace.turn_start(turn, cli.max_turns);

        let chat_start = Instant::now();
        let assistant_content = match executor.chat(&messages) {
            Ok(content) => content,
            Err(error) => {
                let summary = format!("{error:#}");
                trace.run_failed(&summary);
                return Err(error);
            }
        };
        let chat_elapsed_ms = chat_start.elapsed().as_millis();
        println!("{}", redact_secrets(&assistant_content));
        trace.model_response(turn, &assistant_content, chat_elapsed_ms);

        let parsed = match parse_action(&assistant_content) {
            Ok(action) => action,
            Err(error) => {
                let error_message = format!("{error:#}");
                trace.protocol_error(turn, &error_message);
                let result = ToolResult {
                    ok: false,
                    output: format!(
                        "Your response was not valid executor JSON: {error}. Respond with exactly one JSON object using the action protocol."
                    ),
                    truncated: false,
                };
                messages.push(ChatMessage {
                    role: "assistant".to_string(),
                    content: assistant_content,
                });
                messages.push(tool_message("protocol_error", &result)?);
                continue;
            }
        };

        if let Some(note) = parsed.note.as_deref() {
            println!("executor note: {}", redact_secrets(note));
        }
        trace.parsed_action(
            turn,
            parsed.note.as_deref(),
            action_type_name(&parsed.action),
        );

        messages.push(ChatMessage {
            role: "assistant".to_string(),
            content: assistant_content,
        });

        if let Action::Finish { status, summary } = parsed.action {
            let status_str = finish_status_name(&status);
            trace.finish(turn, status_str, &summary);
            write_result(&cli.result_file, &status, &summary, turn)?;
            println!("executor finished with status {:?}: {}", status, summary);
            if status == FinishStatus::Failed {
                std::process::exit(1);
            }
            return Ok(());
        }

        let tool_start = Instant::now();
        let result = executor.execute_action(parsed.action);
        let tool_elapsed_ms = tool_start.elapsed().as_millis();
        println!("tool result: {}", redact_secrets(&result.output));
        trace.tool_result(
            turn,
            result.ok,
            result.truncated,
            &result.output,
            tool_elapsed_ms,
        );
        messages.push(tool_message("tool_result", &result)?);
    }

    let summary = format!(
        "executor reached max turns ({}) without finishing",
        cli.max_turns
    );
    trace.run_failed(&summary);
    write_result(
        &cli.result_file,
        &FinishStatus::Failed,
        &summary,
        cli.max_turns,
    )?;
    bail!("{summary}");
}

impl Executor {
    fn chat(&self, messages: &[ChatMessage]) -> Result<String> {
        let url = format!("{}/chat/completions", self.base_url);
        let mut body = json!({
            "model": self.model,
            "messages": messages,
            "temperature": 0.2,
            "max_tokens": env_u64("EXECUTOR_MAX_RESPONSE_TOKENS", 4096),
        });

        if env_bool("OPENROUTER_REASONING_EXCLUDE", true) {
            body["reasoning"] = json!({ "exclude": true });
        }

        let mut last_error: Option<anyhow::Error> = None;
        for attempt in 1..=3 {
            let response = self
                .client
                .post(&url)
                .bearer_auth(&self.api_key)
                .header("Content-Type", "application/json")
                .header("HTTP-Referer", "https://github.com/cenetex/agent")
                .header("X-Title", "cenetex-agent-executor")
                .json(&body)
                .send();

            match response {
                Ok(response) => {
                    let status = response.status();
                    let text = response.text().context("failed to read model response")?;
                    if !status.is_success() {
                        last_error = Some(anyhow!(
                            "model request failed with HTTP {status}: {}",
                            truncate(&redact_secrets(&text), 2000).0
                        ));
                    } else {
                        match extract_message_content(&text) {
                            Ok(content) => return Ok(content),
                            Err(error) => {
                                last_error = Some(error.context(
                                    "model response did not include usable message content",
                                ));
                            }
                        }
                    }
                }
                Err(error) => {
                    last_error = Some(anyhow!("model request failed: {error}"));
                }
            }

            if attempt < 3 {
                let backoff = Duration::from_secs(attempt * 2);
                eprintln!("model request attempt {attempt} failed, retrying in {backoff:?}");
                thread::sleep(backoff);
            }
        }

        Err(last_error.unwrap_or_else(|| anyhow!("model request failed")))
    }

    fn execute_action(&self, action: Action) -> ToolResult {
        let raw_result = match action {
            Action::ReadFile {
                path,
                start_line,
                max_lines,
            } => self.read_file(&path, start_line.unwrap_or(1), max_lines.unwrap_or(220)),
            Action::WriteFile { path, content } => self.write_file(&path, &content, false),
            Action::ReplaceInFile { path, old, new } => self.replace_in_file(&path, &old, &new),
            Action::AppendFile { path, content } => self.write_file(&path, &content, true),
            Action::Search {
                pattern,
                path,
                max_matches,
            } => self.search(
                &pattern,
                path.as_deref().unwrap_or("."),
                max_matches.unwrap_or(80),
            ),
            Action::ListFiles { path, max_entries } => {
                self.list_files(path.as_deref().unwrap_or("."), max_entries.unwrap_or(300))
            }
            Action::Shell {
                command,
                timeout_seconds,
            } => self.shell(&command, timeout_seconds.unwrap_or(120)),
            Action::GitDiff { max_chars } => self.git_diff(max_chars.unwrap_or(20000)),
            Action::Finish { .. } => unreachable!("finish handled before execute_action"),
        };

        match raw_result {
            Ok(output) => {
                let (output, truncated) =
                    truncate(&redact_secrets(&output), self.max_tool_output_chars);
                ToolResult {
                    ok: true,
                    output,
                    truncated,
                }
            }
            Err(error) => ToolResult {
                ok: false,
                output: redact_secrets(&format!("{error:#}")),
                truncated: false,
            },
        }
    }

    fn replace_in_file(&self, path: &str, old: &str, new: &str) -> Result<String> {
        if old.is_empty() {
            bail!("replace_in_file old text must not be empty");
        }

        let path = self.resolve_path(path, true)?;
        let content = fs::read_to_string(&path)
            .with_context(|| format!("failed to read {}", path.display()))?;
        let matches = content.matches(old).count();
        if matches != 1 {
            bail!(
                "replace_in_file expected exactly one match in {}, found {}",
                path.display(),
                matches
            );
        }

        let updated = content.replacen(old, new, 1);
        fs::write(&path, updated).with_context(|| format!("failed to write {}", path.display()))?;
        Ok(format!(
            "replaced {} bytes with {} bytes in {}",
            old.len(),
            new.len(),
            path.display()
        ))
    }

    fn read_file(&self, path: &str, start_line: usize, max_lines: usize) -> Result<String> {
        let path = self.resolve_path(path, true)?;
        let content = fs::read_to_string(&path)
            .with_context(|| format!("failed to read {}", path.display()))?;
        let start_line = start_line.max(1);
        let end_line = start_line.saturating_add(max_lines).saturating_sub(1);

        let mut output = String::new();
        for (idx, line) in content.lines().enumerate() {
            let line_no = idx + 1;
            if line_no >= start_line && line_no <= end_line {
                output.push_str(&format!("{line_no:>6}  {line}\n"));
            }
        }

        if output.is_empty() {
            output = format!("{} has no lines in requested range", path.display());
        }
        Ok(output)
    }

    fn write_file(&self, path: &str, content: &str, append: bool) -> Result<String> {
        let path = self.resolve_path_for_write(path, true)?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).with_context(|| {
                format!("failed to create parent directory {}", parent.display())
            })?;
        }

        if append {
            let mut file = fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&path)
                .with_context(|| format!("failed to open {} for append", path.display()))?;
            file.write_all(content.as_bytes())
                .with_context(|| format!("failed to append {}", path.display()))?;
            Ok(format!(
                "appended {} bytes to {}",
                content.len(),
                path.display()
            ))
        } else {
            fs::write(&path, content)
                .with_context(|| format!("failed to write {}", path.display()))?;
            Ok(format!(
                "wrote {} bytes to {}",
                content.len(),
                path.display()
            ))
        }
    }

    fn search(&self, pattern: &str, path: &str, max_matches: usize) -> Result<String> {
        let path = self.resolve_path(path, true)?;
        let max_matches = max_matches.max(1).to_string();
        let output = run_process(
            "rg",
            &[
                "-n",
                "--hidden",
                "--glob",
                "!.git/**",
                "--glob",
                "!node_modules/**",
                "--glob",
                "!target/**",
                "--glob",
                "!.next/**",
                "-m",
                &max_matches,
                "--",
                pattern,
                path.to_str().ok_or_else(|| anyhow!("invalid path"))?,
            ],
            &self.cwd,
            Duration::from_secs(30),
        )?;

        if output.code == Some(1) && output.stdout.trim().is_empty() {
            return Ok("no matches".to_string());
        }
        process_output_to_string(output)
    }

    fn list_files(&self, path: &str, max_entries: usize) -> Result<String> {
        let root = self.resolve_path(path, true)?;
        let mut stack = vec![root.clone()];
        let mut entries = Vec::new();
        let max_entries = max_entries.max(1);

        while let Some(dir) = stack.pop() {
            for entry in
                fs::read_dir(&dir).with_context(|| format!("failed to list {}", dir.display()))?
            {
                let entry = entry?;
                let path = entry.path();
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if should_skip_dir(&name) {
                    continue;
                }

                let rel = path.strip_prefix(&self.cwd).unwrap_or(&path);
                entries.push(rel.display().to_string());
                if entries.len() >= max_entries {
                    entries.push(format!("... truncated at {max_entries} entries"));
                    return Ok(entries.join("\n"));
                }

                if path.is_dir() {
                    stack.push(path);
                }
            }
        }

        entries.sort();
        Ok(entries.join("\n"))
    }

    fn shell(&self, command: &str, timeout_seconds: u64) -> Result<String> {
        validate_shell_command(command)?;
        let timeout = Duration::from_secs(timeout_seconds.clamp(1, 900));
        let output = run_process("bash", &["-lc", command], &self.cwd, timeout)?;
        process_output_to_string(output)
    }

    fn git_diff(&self, max_chars: usize) -> Result<String> {
        let stat = run_process(
            "git",
            &["diff", "--stat"],
            &self.cwd,
            Duration::from_secs(30),
        )?;
        let diff = run_process("git", &["diff", "--"], &self.cwd, Duration::from_secs(30))?;
        let combined = format!(
            "git diff --stat:\n{}\n\ngit diff:\n{}",
            process_output_to_string(stat)?,
            process_output_to_string(diff)?
        );
        Ok(truncate(&combined, max_chars).0)
    }

    fn resolve_path(&self, path: &str, allow_tmp: bool) -> Result<PathBuf> {
        let candidate = if Path::new(path).is_absolute() {
            PathBuf::from(path)
        } else {
            self.cwd.join(path)
        };
        let canonical = candidate
            .canonicalize()
            .with_context(|| format!("failed to resolve path {}", candidate.display()))?;
        self.ensure_allowed_path(&canonical, allow_tmp)?;
        Ok(canonical)
    }

    fn resolve_path_for_write(&self, path: &str, allow_tmp: bool) -> Result<PathBuf> {
        let candidate = if Path::new(path).is_absolute() {
            PathBuf::from(path)
        } else {
            self.cwd.join(path)
        };

        let mut ancestor = candidate
            .parent()
            .ok_or_else(|| anyhow!("path has no parent: {}", candidate.display()))?
            .to_path_buf();
        while !ancestor.exists() {
            ancestor = ancestor
                .parent()
                .ok_or_else(|| anyhow!("path has no existing ancestor: {}", candidate.display()))?
                .to_path_buf();
        }

        let canonical_ancestor = ancestor
            .canonicalize()
            .with_context(|| format!("failed to resolve ancestor path {}", ancestor.display()))?;
        self.ensure_allowed_path(&canonical_ancestor, allow_tmp)?;
        Ok(candidate)
    }

    fn ensure_allowed_path(&self, path: &Path, allow_tmp: bool) -> Result<()> {
        if path.starts_with(&self.cwd) {
            return Ok(());
        }
        if allow_tmp && is_tmp_path(path) {
            return Ok(());
        }
        bail!("path outside repository is not allowed: {}", path.display())
    }
}

fn resolve_repo_cwd(repo: Option<&Path>) -> Result<PathBuf> {
    match repo {
        Some(repo) => {
            if !repo.is_dir() {
                bail!(
                    "--repo must point to an existing directory: {}",
                    repo.display()
                );
            }
            repo.canonicalize()
                .with_context(|| format!("failed to resolve repo path {}", repo.display()))
        }
        None => env::current_dir().context("failed to read current directory"),
    }
}

fn action_type_name(action: &Action) -> &'static str {
    match action {
        Action::ReadFile { .. } => "read_file",
        Action::WriteFile { .. } => "write_file",
        Action::ReplaceInFile { .. } => "replace_in_file",
        Action::AppendFile { .. } => "append_file",
        Action::Search { .. } => "search",
        Action::ListFiles { .. } => "list_files",
        Action::Shell { .. } => "shell",
        Action::GitDiff { .. } => "git_diff",
        Action::Finish { .. } => "finish",
    }
}

fn finish_status_name(status: &FinishStatus) -> &'static str {
    match status {
        FinishStatus::Succeeded => "succeeded",
        FinishStatus::Waiting => "waiting",
        FinishStatus::Failed => "failed",
    }
}

fn is_tmp_path(path: &Path) -> bool {
    if path.starts_with("/tmp") || path.starts_with("/private/tmp") {
        return true;
    }

    env::temp_dir()
        .canonicalize()
        .map(|tmp| path.starts_with(tmp))
        .unwrap_or(false)
}

fn is_allowed_trace_path(path: &Path, repo: &Path) -> bool {
    path.starts_with(repo) || is_tmp_path(path)
}

fn nearest_existing_ancestor(path: &Path) -> Result<PathBuf> {
    let mut ancestor = path;
    loop {
        if ancestor.exists() {
            return ancestor.canonicalize().with_context(|| {
                format!("failed to resolve existing ancestor {}", ancestor.display())
            });
        }
        ancestor = ancestor
            .parent()
            .ok_or_else(|| anyhow!("path has no existing ancestor: {}", path.display()))?;
    }
}

fn parse_action(content: &str) -> Result<ActionEnvelope> {
    let json_text = extract_json_object(content)?;
    serde_json::from_str(&json_text).with_context(|| format!("invalid action JSON: {json_text}"))
}

fn extract_json_object(content: &str) -> Result<String> {
    let trimmed = content.trim();
    if trimmed.starts_with('{') && trimmed.ends_with('}') {
        return Ok(trimmed.to_string());
    }

    if let Some(fenced) = extract_fenced_json(trimmed) {
        return Ok(fenced);
    }

    let start = trimmed
        .find('{')
        .ok_or_else(|| anyhow!("missing opening JSON brace"))?;
    let end = trimmed
        .rfind('}')
        .ok_or_else(|| anyhow!("missing closing JSON brace"))?;
    if end <= start {
        bail!("invalid JSON object bounds");
    }
    Ok(trimmed[start..=end].to_string())
}

fn extract_fenced_json(content: &str) -> Option<String> {
    let marker = "```";
    let start = content.find(marker)?;
    let after_start = &content[start + marker.len()..];
    let after_lang = after_start
        .strip_prefix("json")
        .unwrap_or(after_start)
        .trim_start_matches(['\r', '\n']);
    let end = after_lang.find(marker)?;
    Some(after_lang[..end].trim().to_string())
}

fn tool_message(kind: &str, result: &ToolResult) -> Result<ChatMessage> {
    Ok(ChatMessage {
        role: "user".to_string(),
        content: format!(
            "{kind}:\n{}",
            serde_json::to_string_pretty(result).context("failed to encode tool result")?
        ),
    })
}

fn extract_message_content(response_text: &str) -> Result<String> {
    let value: Value = serde_json::from_str(response_text).with_context(|| {
        format!(
            "model returned invalid JSON: {}",
            truncate(response_text, 2000).0
        )
    })?;
    let content = &value["choices"][0]["message"]["content"];

    if let Some(content) = content.as_str() {
        return Ok(content.to_string());
    }

    if let Some(parts) = content.as_array() {
        let mut output = String::new();
        for part in parts {
            if let Some(text) = part.get("text").and_then(Value::as_str) {
                output.push_str(text);
            }
        }
        if !output.is_empty() {
            return Ok(output);
        }
    }

    bail!(
        "model response did not include message content: {}",
        truncate(response_text, 2000).0
    )
}

fn run_process(
    program: &str,
    args: &[&str],
    cwd: &Path,
    timeout: Duration,
) -> Result<ProcessOutput> {
    let mut child = Command::new(program)
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .with_context(|| format!("failed to spawn {program}"))?;

    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow!("failed to capture stdout"))?;
    let mut stderr = child
        .stderr
        .take()
        .ok_or_else(|| anyhow!("failed to capture stderr"))?;

    let stdout_handle = thread::spawn(move || {
        let mut buffer = Vec::new();
        let _ = stdout.read_to_end(&mut buffer);
        buffer
    });
    let stderr_handle = thread::spawn(move || {
        let mut buffer = Vec::new();
        let _ = stderr.read_to_end(&mut buffer);
        buffer
    });

    let start = Instant::now();
    let mut timed_out = false;
    let status = loop {
        if let Some(status) = child
            .try_wait()
            .context("failed while waiting for process")?
        {
            break status;
        }
        if start.elapsed() >= timeout {
            timed_out = true;
            let _ = child.kill();
            let status = child
                .wait()
                .context("failed to wait after killing process")?;
            break status;
        }
        thread::sleep(Duration::from_millis(100));
    };

    let stdout = stdout_handle
        .join()
        .map_err(|_| anyhow!("stdout reader thread panicked"))?;
    let stderr = stderr_handle
        .join()
        .map_err(|_| anyhow!("stderr reader thread panicked"))?;

    Ok(ProcessOutput {
        code: status.code(),
        stdout: String::from_utf8_lossy(&stdout).to_string(),
        stderr: String::from_utf8_lossy(&stderr).to_string(),
        timed_out,
    })
}

fn process_output_to_string(output: ProcessOutput) -> Result<String> {
    let mut combined = String::new();
    combined.push_str(&format!("exit_code: {:?}\n", output.code));
    if output.timed_out {
        combined.push_str("timed_out: true\n");
    }
    if !output.stdout.is_empty() {
        combined.push_str("\nstdout:\n");
        combined.push_str(&output.stdout);
    }
    if !output.stderr.is_empty() {
        combined.push_str("\nstderr:\n");
        combined.push_str(&output.stderr);
    }
    Ok(combined)
}

fn validate_shell_command(command: &str) -> Result<()> {
    let lower = command.to_lowercase();
    let blocked = [
        "printenv",
        "/proc/self/environ",
        "aws ssm get-parameter",
        "aws secretsmanager",
        "github_token",
        "openrouter_api_key",
        "anthropic_api_key",
        "aws_secret_access_key",
        "aws_session_token",
        "rm -rf /",
        ":(){",
    ];

    for pattern in blocked {
        if lower.contains(pattern) {
            bail!("blocked shell command pattern: {pattern}");
        }
    }

    Ok(())
}

fn should_skip_dir(name: &str) -> bool {
    matches!(
        name,
        ".git" | "node_modules" | "target" | ".next" | "dist" | "build" | "__pycache__"
    )
}

fn truncate(input: &str, max_chars: usize) -> (String, bool) {
    if input.chars().count() <= max_chars {
        return (input.to_string(), false);
    }

    let mut output: String = input.chars().take(max_chars).collect();
    output.push_str("\n... truncated ...");
    (output, true)
}

fn redact_secrets(input: &str) -> String {
    let mut output = input.to_string();
    for key in [
        "GITHUB_TOKEN",
        "GH_TOKEN",
        "OPENROUTER_API_KEY",
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        "AWS_SECRET_ACCESS_KEY",
        "AWS_SESSION_TOKEN",
    ] {
        if let Ok(value) = env::var(key) {
            if value.len() >= 4 {
                output = output.replace(&value, "[REDACTED]");
            }
        }
    }
    output
}

fn write_result(path: &Path, status: &FinishStatus, summary: &str, turns: usize) -> Result<()> {
    let payload = json!({
        "status": status,
        "summary": summary,
        "turns": turns,
        "completed_unix_seconds": unix_now(),
    });

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("failed to create result directory {}", parent.display()))?;
    }
    fs::write(path, serde_json::to_vec_pretty(&payload)?)
        .with_context(|| format!("failed to write result file {}", path.display()))
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_else(|_| Duration::from_secs(0))
        .as_secs()
}

fn env_u64(name: &str, default: u64) -> u64 {
    env::var(name)
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(default)
}

fn env_bool(name: &str, default: bool) -> bool {
    env::var(name)
        .ok()
        .map(|value| {
            matches!(
                value.to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(default)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unique_temp_dir(prefix: &str) -> PathBuf {
        env::temp_dir().join(format!(
            "{}-{}",
            prefix,
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock should be after unix epoch")
                .as_nanos()
        ))
    }

    #[test]
    fn parses_plain_action_json() {
        let action = parse_action(
            r#"{"note":"next","action":{"type":"finish","status":"succeeded","summary":"done"}}"#,
        )
        .expect("action should parse");

        assert_eq!(action.note.as_deref(), Some("next"));
        match action.action {
            Action::Finish { status, summary } => {
                assert_eq!(status, FinishStatus::Succeeded);
                assert_eq!(summary, "done");
            }
            _ => panic!("expected finish action"),
        }
    }

    #[test]
    fn parses_fenced_action_json() {
        let action = parse_action(
            r#"```json
{"thought":"legacy","action":{"type":"search","pattern":"foo","path":".","max_matches":5}}
```"#,
        )
        .expect("fenced action should parse");

        assert_eq!(action.note.as_deref(), Some("legacy"));
        match action.action {
            Action::Search {
                pattern,
                path,
                max_matches,
            } => {
                assert_eq!(pattern, "foo");
                assert_eq!(path.as_deref(), Some("."));
                assert_eq!(max_matches, Some(5));
            }
            _ => panic!("expected search action"),
        }
    }

    #[test]
    fn blocks_secret_or_env_dump_commands() {
        assert!(validate_shell_command("npm test").is_ok());
        assert!(validate_shell_command("printenv").is_err());
        assert!(validate_shell_command("echo $GITHUB_TOKEN").is_err());
    }

    #[test]
    fn search_accepts_patterns_that_start_with_dash() {
        let test_dir = unique_temp_dir("agent-executor-search-test");
        fs::create_dir_all(&test_dir).expect("test dir should be created");
        fs::write(test_dir.join("sample.txt"), "--new --load\n")
            .expect("sample file should be written");
        let test_dir = test_dir
            .canonicalize()
            .expect("test dir should canonicalize");

        let executor = Executor {
            client: Client::new(),
            api_key: String::new(),
            base_url: String::new(),
            model: String::new(),
            cwd: test_dir.clone(),
            max_tool_output_chars: 12000,
        };

        let output = executor
            .search("--new|--load", ".", 10)
            .expect("search should not treat the pattern as an rg flag");
        assert!(output.contains("sample.txt"));

        fs::remove_dir_all(test_dir).expect("test dir should be removed");
    }

    #[test]
    fn write_file_allows_canonical_tmp_paths() {
        let cwd = env::current_dir()
            .expect("cwd should exist")
            .canonicalize()
            .expect("cwd should canonicalize");
        let output_path = PathBuf::from("/tmp").join(format!(
            "agent-executor-write-test-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock should be after unix epoch")
                .as_nanos()
        ));

        let executor = Executor {
            client: Client::new(),
            api_key: String::new(),
            base_url: String::new(),
            model: String::new(),
            cwd,
            max_tool_output_chars: 12000,
        };

        executor
            .write_file(
                output_path
                    .to_str()
                    .expect("tmp path should be valid unicode"),
                "ok\n",
                false,
            )
            .expect("write_file should allow /tmp even when canonicalized");
        assert_eq!(
            fs::read_to_string(&output_path).expect("tmp file should be readable"),
            "ok\n"
        );

        fs::remove_file(output_path).expect("tmp file should be removed");
    }

    #[test]
    fn replace_in_file_requires_one_exact_match() {
        let test_dir = unique_temp_dir("agent-executor-replace-test");
        fs::create_dir_all(&test_dir).expect("test dir should be created");
        let test_dir = test_dir
            .canonicalize()
            .expect("test dir should canonicalize");
        let sample = test_dir.join("sample.txt");
        fs::write(&sample, "alpha\nbeta\ngamma\n").expect("sample should be written");

        let executor = Executor {
            client: Client::new(),
            api_key: String::new(),
            base_url: String::new(),
            model: String::new(),
            cwd: test_dir.clone(),
            max_tool_output_chars: 12000,
        };

        executor
            .replace_in_file("sample.txt", "beta\n", "delta\n")
            .expect("unique replacement should succeed");
        assert_eq!(
            fs::read_to_string(&sample).expect("sample should be readable"),
            "alpha\ndelta\ngamma\n"
        );

        fs::write(&sample, "same\nsame\n").expect("sample should be rewritten");
        let error = executor
            .replace_in_file("sample.txt", "same\n", "once\n")
            .expect_err("ambiguous replacement should fail");
        assert!(format!("{error:#}").contains("found 2"));

        fs::remove_dir_all(test_dir).expect("test dir should be removed");
    }

    #[test]
    fn null_model_content_is_an_extract_error() {
        let response = r#"{"choices":[{"message":{"content":null}}]}"#;
        let error = extract_message_content(response).expect_err("null content should fail");
        assert!(format!("{error:#}").contains("message content"));
    }

    #[test]
    fn resolve_repo_cwd_uses_repo_argument() {
        let repo = unique_temp_dir("agent-executor-repo-test");
        fs::create_dir_all(&repo).expect("repo dir should be created");
        let expected = repo.canonicalize().expect("repo should canonicalize");

        let actual = resolve_repo_cwd(Some(&repo)).expect("--repo should resolve");
        assert_eq!(actual, expected);

        fs::remove_dir_all(repo).expect("repo dir should be removed");
    }

    #[test]
    fn trace_writer_emits_valid_redacted_jsonl() {
        let repo = unique_temp_dir("agent-executor-trace-test");
        fs::create_dir_all(&repo).expect("repo dir should be created");
        let repo = repo.canonicalize().expect("repo should canonicalize");
        let trace_path = repo.join("traces/run.jsonl");
        let secret = "trace-secret-value-123";

        env::set_var("ANTHROPIC_AUTH_TOKEN", secret);
        let mut trace = TraceWriter::open(&trace_path, &repo).expect("trace should open");
        trace.model_response(7, &format!("before {secret} after"), 42);
        drop(trace);
        env::remove_var("ANTHROPIC_AUTH_TOKEN");

        let content = fs::read_to_string(&trace_path).expect("trace should be readable");
        let line = content.lines().next().expect("trace should have one line");
        let value: Value = serde_json::from_str(line).expect("trace line should be JSON");
        assert_eq!(value["event"], "model_response");
        assert_eq!(value["turn"], 7);
        let traced_content = value["content"].as_str().expect("content should be string");
        assert!(traced_content.contains("[REDACTED]"));
        assert!(!traced_content.contains(secret));

        fs::remove_dir_all(repo).expect("repo dir should be removed");
    }

    #[test]
    fn trace_writer_allows_tmp_paths_with_new_parent() {
        let repo = unique_temp_dir("agent-executor-trace-repo-test");
        fs::create_dir_all(&repo).expect("repo dir should be created");
        let repo = repo.canonicalize().expect("repo should canonicalize");
        let trace_path = PathBuf::from("/tmp").join(format!(
            "agent-executor-trace-out-{}/trace.jsonl",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock should be after unix epoch")
                .as_nanos()
        ));

        let mut trace = TraceWriter::open(&trace_path, &repo).expect("/tmp trace should open");
        trace.run_failed("done");
        drop(trace);

        let content = fs::read_to_string(&trace_path).expect("tmp trace should be readable");
        let value: Value = serde_json::from_str(content.trim()).expect("trace should be JSON");
        assert_eq!(value["event"], "run_failed");
        assert!(is_tmp_path(Path::new("/private/tmp/example.jsonl")));

        fs::remove_file(&trace_path).expect("tmp trace should be removed");
        if let Some(parent) = trace_path.parent() {
            let _ = fs::remove_dir(parent);
        }
        fs::remove_dir_all(repo).expect("repo dir should be removed");
    }

    #[test]
    fn truncates_long_output() {
        let (output, truncated) = truncate("abcdef", 3);
        assert!(truncated);
        assert_eq!(output, "abc\n... truncated ...");
    }
}
