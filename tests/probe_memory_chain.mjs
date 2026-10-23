async function testMemoryChain() {
  const sessionId = `mem-chain-${Date.now()}`;
  console.log(`Starting memory chain test in session ${sessionId}...\n`);

  const turns = [
    {
      id: '056',
      prompt: 'For this conversation, remember: my preferred language is Rust, my database is MySQL, my project is called Orion, and I prefer concise technical explanations. Acknowledge these details.'
    },
    {
      id: '057',
      prompt: 'What programming language do I prefer, which database do I use, what is my project called, and what explanation style do I prefer? Use exactly four bullet points.'
    },
    {
      id: '058',
      prompt: 'For this conversation, my budget is ₹15,000 and my deadline is 30 November. Acknowledge these details.'
    },
    {
      id: '059',
      prompt: 'What budget and deadline did I specify? If either is missing from the conversation, say so.'
    },
    {
      id: '060',
      prompt: 'Correction: I previously said my project was Orion, but it is now called Pegasus. Confirm the new project name.'
    }
  ];

  for (const turn of turns) {
    console.log(`=== Turn ${turn.id} ===`);
    console.log(`User: ${turn.prompt}`);
    const res = await fetch('http://127.0.0.1:3000/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: turn.prompt }],
        sessionId
      })
    });
    const data = await res.json();
    console.log(`Assistant:\n${data.message?.content}\n`);
  }
}

testMemoryChain();
