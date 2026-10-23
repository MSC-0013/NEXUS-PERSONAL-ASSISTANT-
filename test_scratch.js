async function testPrompt() {
  const sys = `You are NEXUS, an autonomous personal assistant adhering strictly to agent-contract-v1.json.
Your response MUST be a valid JSON object adhering to agent-contract-v1.json:
- If you need to read a file, output: {"kind": "tool_call", "name": "read_workspace_file", "arguments": {"relative_path": "<path>"}}
- If you need to check time, output: {"kind": "tool_call", "name": "get_current_time", "arguments": {"timezone": "<timezone>"}}
- If you have the final answer, output: {"kind": "final", "content": "<answer>"}`;

  const user = "What is the current time in UTC and in Asia/Kolkata?";
  const prompt = `<|im_start|>system\n${sys}<|im_end|>\n<|im_start|>user\n${user}<|im_end|>\n<|im_start|>assistant\n`;

  const res = await fetch("http://127.0.0.1:11434/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "nexus:latest",
      prompt,
      raw: true,
      stream: false,
      options: { num_predict: 256, temperature: 0.1 }
    })
  });
  const d = await res.json();
  console.log("Model response:\n", d.response);
}

testPrompt();
