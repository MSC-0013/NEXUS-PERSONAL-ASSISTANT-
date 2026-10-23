process.env.NODE_ENV = "test";
import { buildSystemPrompt, normalizeAssistantResponse } from "../apps/chat-gateway/dist/server.js";

async function main() {
  const sys = buildSystemPrompt([]);
  const prompt = `<|im_start|>system\n${sys}<|im_end|>\n<|im_start|>user\nDefine authentication and authorization using exactly three bullet points. Each bullet must contain fewer than 12 words. Include no introduction or conclusion.<|im_end|>\n<|im_start|>assistant\n`;
  const res = await fetch("http://127.0.0.1:11434/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "nexus:latest",
      prompt,
      raw: true,
      stream: false,
      options: { num_predict: 1024, temperature: 0.1 }
    })
  });
  const data = await res.json();
  console.log("RESPONSE:\n" + data.response);
  const norm = normalizeAssistantResponse(data.response, data.thinking);
  console.log("NORMALIZED:\n", norm);
  process.exit(0);
}

main();
