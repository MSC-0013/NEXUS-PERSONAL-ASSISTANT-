async function test() {
  const tests = [
    { id: '001', prompt: 'Define authentication and authorization using exactly three bullet points. Each bullet must contain fewer than 12 words. Include no introduction or conclusion.' },
    { id: '003', prompt: 'What is 6 multiplied by 7? Reply with only the number.' },
    { id: '004', prompt: 'Return valid JSON only, with exactly these keys: "name", "priority", and "status". Use values "Review API", "high", and "pending" respectively. Do not include markdown fences.' },
    { id: '011', prompt: 'Three switches are outside a room containing one incandescent bulb. Exactly one switch controls it. You may enter the room once. Give the switch sequence and explain what ON, OFF-but-warm, and OFF-and-cold mean.' },
    { id: '023', prompt: 'Aggregate these sales: East 1200, West 1800, East 800, South 1500, West 700, South 500, North 2600, North 900. Give each region total, overall total, and descending ranking.' },
    { id: '061', prompt: 'Write a TypeScript function to sum sales by region. Use explicit types, return an empty result for empty input, and include tests for normal input, repeated regions, and empty input. Do not claim tests ran unless executed.' }
  ];

  for (const t of tests) {
    console.log(`\n=== Testing ${t.id} ===`);
    try {
      const res = await fetch('http://127.0.0.1:3000/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: t.prompt }],
          sessionId: `test-${t.id}-${Date.now()}`,
          maxTokens: 1024
        })
      });
      const data = await res.json();
      console.log(data.message?.content);
    } catch (err) {
      console.error('Error:', err.message);
    }
  }
}
test();
