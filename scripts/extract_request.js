const fs = require('fs');
const readline = require('readline');

const rl = readline.createInterface({
  input: fs.createReadStream('C:\\Users\\HP\\.gemini\\antigravity\\brain\\9f784d6d-482f-4ac6-95e7-22546c7459bd\\.system_generated\\logs\\transcript_full.jsonl'),
  crlfDelay: Infinity
});

rl.on('line', (line) => {
  if (line.includes('"step_index":3716')) {
    const data = JSON.parse(line);
    fs.writeFileSync('c:\\MSC\\my-desk\\ai-personal-assistants\\current_request_raw.txt', data.content, 'utf8');
    console.log('Saved raw request, character length:', data.content.length);
    process.exit(0);
  }
});
