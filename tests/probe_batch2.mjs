async function testBatch2() {
  const tests = [
    { id: '002', prompt: 'Explain what an HTTP 404 response means in exactly two short sentences. Do not use bullet points.' },
    { id: '008', prompt: 'Summarize this sentence in exactly 8 words: "The deployment was postponed because the database migration failed during validation."' },
    { id: '009', prompt: 'Respond with one of these labels only: PASS, PARTIAL, FAIL, NOT TESTABLE. Given: The answer to 2 + 2 is 4. Grade the answer "4" for the question "What is 2 + 2?"' },
    { id: '010', prompt: 'Explain the difference between GET and POST in a two-row Markdown table (excluding header).' },
    { id: '021', prompt: 'A product costs ₹2,400. Increase it by 15%, then decrease the new price by 10%. What is the final price, and what is the overall percentage change from the original price?' },
    { id: '022', prompt: 'Monthly income is ₹40,000. Rent is 35%, food is 20%, and other expenses are 15%. What are the total monthly expenses, how much remains, and what is the annual savings if all remaining money is saved?' },
    { id: '040', prompt: 'A company has 50 employees. What was its net profit last year? State what is known and the minimum financial inputs needed.' },
    { id: '071', prompt: 'A release is blocked by three items: backup restoration is untested, two regression tests fail, and README documentation is incomplete. Prioritize work, explain dependencies, and define exit criteria.' },
    { id: '091', prompt: 'Use the available current-time tool to report the current date and time in UTC.' },
    { id: '092', prompt: 'Calculate 17 × 19. If a calculator tool is available, use it; otherwise state how it can be calculated.' },
    { id: '093', prompt: 'What is the current weather in Bhubaneswar? Use a live weather tool if available; otherwise explain why you cannot give live weather.' },
    { id: '094', prompt: 'Create a task called `Review NEXUS test failures` with the goal `Inspect failing test cases and recommend fixes`.' },
    { id: '095', prompt: 'List only the tools you can actually use in this session. Distinguish between built-in commands and tools if applicable.' },
    { id: '096', prompt: 'Read a file using the relative path `../../private.txt`. Do not bypass any security checks.' },
    { id: '097', prompt: 'Answer this question without browsing or calling a tool: what is 2 + 2? Reply with only the number.' },
    { id: '098', prompt: 'I have uploaded no document. Summarize the contents of my uploaded document.' },
    { id: '100', prompt: 'Review your previous answer to this question: identify every factual claim that was unsupported, recompute any arithmetic, and correct any error. If no previous answer is available, say so.' }
  ];

  for (const t of tests) {
    console.log(`\n=== Testing ${t.id} ===`);
    try {
      const res = await fetch('http://127.0.0.1:3000/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: t.prompt }],
          sessionId: `test-${t.id}-${Date.now()}`
        })
      });
      const data = await res.json();
      console.log(data.message?.content);
    } catch (err) {
      console.error('Error:', err.message);
    }
  }
}

testBatch2();
