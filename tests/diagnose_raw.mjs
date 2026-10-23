async function testRaw(prompt) {
  const systemPrompt = `You are NEXUS, an autonomous personal assistant adhering strictly to agent-contract-v1.json.
Output Format: You may return your final answer in clean Markdown (or {"kind": "final", "content": "..."}).
Do not leak internal thoughts or thinking tags. Adhere strictly to user constraints.`;

  const body = {
    model: "nexus:latest",
    prompt: `<|im_start|>system\n${systemPrompt}<|im_end|>\n<|im_start|>user\n${prompt}<|im_end|>\n<|im_start|>assistant\n`,
    raw: true,
    stream: false,
    options: {
      num_predict: 1024,
      temperature: 0.1
    }
  };

  const res = await fetch("http://127.0.0.1:11434/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  return data;
}

async function main() {
  const tests = [
    { id: '001', prompt: 'Define authentication and authorization using exactly three bullet points. Each bullet must contain fewer than 12 words. Include no introduction or conclusion.' },
    { id: '002', prompt: 'Explain what an HTTP 404 response means in exactly two short sentences. Do not use bullet points.' },
    { id: '008', prompt: 'Summarize this sentence in exactly 8 words: "The deployment was postponed because the database migration failed during validation."' },
    { id: '040', prompt: 'A company has 50 employees. What was its net profit last year? State what is known and the minimum financial inputs needed.' },
  ];

  for (const t of tests) {
    console.log(`\n================= TEST ${t.id} =================`);
    const res = await testRaw(t.prompt);
    console.log("RAW RESPONSE:\n", res.response);
    if (res.thinking) console.log("RAW THINKING:\n", res.thinking);
  }
}

main();
