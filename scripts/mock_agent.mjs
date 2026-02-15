#!/usr/bin/env node

function parse(argv) {
  const out = { name: "agent", session: "", prompt: "" };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--name") out.name = argv[++i] ?? out.name;
    if (arg === "--session") out.session = argv[++i] ?? "";
    if (arg === "--prompt") out.prompt = argv[++i] ?? "";
  }
  return out;
}

const args = parse(process.argv);
const session = args.session || `${args.name}-session-1`;
let text = `${args.name} 응답: ${args.prompt.slice(0, 120)}`;
if (/합의|동의|consensus|agreed/i.test(args.prompt)) {
  text = `${args.name} 응답: 합의: 동의합니다.`;
}

console.log(JSON.stringify({ session_id: session, text }));
